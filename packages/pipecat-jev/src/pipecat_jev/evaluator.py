"""Runtime-faithful batch evaluator for `menu.json` `evals[]` suites."""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any, Literal

from .client import JevClient
from .schema import UNCLEAR, MenuEvalCase, MenuGraph


@dataclass
class EvalFailure:
    index: int
    split: str
    node: str
    say: str
    expected: str
    actual: str
    raw_choice: str
    confidence: float
    threshold: float
    probabilities: dict[str, float]
    collision_with: str | None
    margin: float | None
    extracted_mismatch: dict[str, dict[str, Any]] | None


@dataclass
class EvalSummary:
    menu_id: str
    menu_sha256: str
    resolved_model: str
    split: str
    total: int
    passed: int
    failed: int
    pass_rate: float
    coverage_errors: list[str]
    failures: list[EvalFailure]

    @property
    def ok(self) -> bool:
        return self.total > 0 and self.failed == 0 and len(self.coverage_errors) == 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "menu_id": self.menu_id,
            "menu_sha256": self.menu_sha256,
            "resolved_model": self.resolved_model,
            "split": self.split,
            "total": self.total,
            "passed": self.passed,
            "failed": self.failed,
            "pass_rate": self.pass_rate,
            "coverage_errors": self.coverage_errors,
            "failures": [asdict(f) for f in self.failures],
        }


def compute_menu_sha256(graph: MenuGraph) -> str:
    canonical = json.dumps(graph.model_dump(exclude_none=True), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def evaluate_menu_graph(
    *,
    graph: MenuGraph,
    client: JevClient,
    split: Literal["all", "tune", "holdout"] = "all",
    node_filter: str | None = None,
    concurrency: int = 8,
    require_full_coverage: bool = True,
) -> EvalSummary:
    all_cases = graph.evals or []
    selected: list[tuple[int, MenuEvalCase]] = []
    for idx, case in enumerate(all_cases):
        if split != "all" and case.split != split:
            continue
        if node_filter and case.node != node_filter:
            continue
        selected.append((idx, case))

    coverage_errors: list[str] = []
    if len(selected) == 0:
        coverage_errors.append(f"No eval cases matched split={split!r} node={node_filter!r}.")
    elif require_full_coverage and node_filter is None:
        covered_pairs = {f"{c.node}:{c.expect}" for _, c in selected}
        for n_id, node in graph.nodes.items():
            for opt in node.options:
                if f"{n_id}:{opt.id}" not in covered_pairs:
                    coverage_errors.append(
                        f"Missing {split} eval coverage for option '{opt.id}' in node '{n_id}'."
                    )
        if not any(c.expect == UNCLEAR for _, c in selected):
            coverage_errors.append(
                f"Missing negative out-of-scope (`expect: \"unclear\"`) case in split={split!r}."
            )

    sem = asyncio.Semaphore(max(1, concurrency))
    resolved_models: list[str] = []
    failures: list[EvalFailure] = []
    passed = 0

    async def run_one(idx: int, case: MenuEvalCase) -> EvalFailure | None:
        async with sem:
            history = (
                [{"role": h.role, "text": h.text} for h in case.history]
                if case.history
                else None
            )
            res = await client.classify_turn(
                graph=graph,
                node_id=case.node,
                stack=case.stack,
                turn=case.say,
                history=history,
            )
            resolved_models.append(res.resolved_model)

            actual = res.step.outcome_choice
            extracted_mismatch: dict[str, dict[str, Any]] | None = None
            if case.expectExtracted:
                mismatches: dict[str, dict[str, Any]] = {}
                for q_key, exp_val in case.expectExtracted.items():
                    got_val = (
                        res.secondary_answers[q_key].value
                        if q_key in res.secondary_answers
                        else res.step.extracted.get(q_key)
                    )
                    if got_val != exp_val:
                        mismatches[q_key] = {"expected": exp_val, "actual": got_val}
                if mismatches:
                    extracted_mismatch = mismatches

            if actual == case.expect and not extracted_mismatch:
                return None

            node_cfg = graph.nodes[case.node]
            threshold = (
                node_cfg.confidenceThreshold
                if node_cfg.confidenceThreshold is not None
                else graph.confidenceThreshold
            )
            collision_with, margin = _compute_collision(res.probabilities, case.expect)
            return EvalFailure(
                index=idx,
                split=case.split,
                node=case.node,
                say=case.say,
                expected=case.expect,
                actual=actual,
                raw_choice=res.raw_choice,
                confidence=res.confidence,
                threshold=threshold,
                probabilities=res.probabilities,
                collision_with=collision_with,
                margin=margin,
                extracted_mismatch=extracted_mismatch,
            )

    results = await asyncio.gather(*(run_one(idx, case) for idx, case in selected))
    for item in results:
        if item is None:
            passed += 1
        else:
            failures.append(item)

    total = len(selected)
    failed = len(failures)
    pass_rate = round(passed / total, 4) if total > 0 else 0.0
    resolved_model = resolved_models[0] if resolved_models else "none"

    return EvalSummary(
        menu_id=graph.id,
        menu_sha256=compute_menu_sha256(graph),
        resolved_model=resolved_model,
        split=split,
        total=total,
        passed=passed,
        failed=failed,
        pass_rate=pass_rate,
        coverage_errors=coverage_errors,
        failures=failures,
    )


def _compute_collision(
    probabilities: dict[str, float],
    expected: str,
) -> tuple[str | None, float | None]:
    if not probabilities:
        return None, None
    ranked = sorted(probabilities.items(), key=lambda kv: kv[1], reverse=True)
    expected_prob = probabilities.get(expected, 0.0)
    competitors = [(k, p) for k, p in ranked if k != expected]
    if not competitors:
        return None, None
    top_rival, rival_prob = competitors[0]
    return top_rival, round(expected_prob - rival_prob, 4)
