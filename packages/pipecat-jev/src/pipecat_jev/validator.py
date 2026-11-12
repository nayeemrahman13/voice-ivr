"""Graph reachability, cycle exit verification, and voice-UX linter."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from .schema import (
    UNCLEAR,
    EndCallAction,
    FallbackGoto,
    GlobalOperatorObject,
    GotoAction,
    HandoffLlmAction,
    MenuGraph,
    MenuNode,
    ReplyOnlyAction,
    TransferAction,
    WebhookAction,
)


@dataclass(frozen=True)
class ValidationIssue:
    code: str
    path: str
    message: str


@dataclass(frozen=True)
class ValidationReport:
    valid: bool
    errors: list[ValidationIssue]
    warnings: list[ValidationIssue]

    def to_dict(self) -> dict[str, Any]:
        return {
            "valid": self.valid,
            "errors": [asdict(e) for e in self.errors],
            "warnings": [asdict(w) for w in self.warnings],
        }


def validate_menu_graph(graph: MenuGraph) -> ValidationReport:
    errors: list[ValidationIssue] = []
    warnings: list[ValidationIssue] = []

    # 1. Reachability from entry + initialStack
    reachable: set[str] = set()
    queue: list[str] = [graph.entry, *(graph.initialStack or [])]
    while queue:
        cur = queue.pop(0)
        if cur in reachable or cur not in graph.nodes:
            continue
        reachable.add(cur)
        for target in _outgoing_targets(graph, cur):
            if target not in reachable:
                queue.append(target)

    for node_id in graph.nodes:
        if node_id not in reachable:
            errors.append(
                ValidationIssue(
                    code="orphan_node",
                    path=f"nodes.{node_id}",
                    message=f"Node {node_id!r} is unreachable from entry {graph.entry!r}.",
                )
            )

    # 2. Every reachable node must have a path to at least one terminal exit action
    can_exit: set[str] = {
        node_id for node_id, node in graph.nodes.items() if _node_has_direct_exit(graph, node)
    }
    changed = True
    while changed:
        changed = False
        for node_id in graph.nodes:
            if node_id in can_exit:
                continue
            if any(t in can_exit for t in _outgoing_targets(graph, node_id)):
                can_exit.add(node_id)
                changed = True

    for node_id in reachable:
        if node_id not in can_exit:
            errors.append(
                ValidationIssue(
                    code="trapped_cycle",
                    path=f"nodes.{node_id}",
                    message=(
                        f"Node {node_id!r} is trapped in a cycle with no reachable terminal action "
                        "(end_call, transfer, handoff_llm, or reply_only)."
                    ),
                )
            )

    # 3. Voice UX checks & eval coverage
    eval_pairs = {f"{ev.node}:{ev.expect}" for ev in (graph.evals or [])}
    has_unclear_eval = any(ev.expect == UNCLEAR for ev in (graph.evals or []))

    for node_id, node in graph.nodes.items():
        if len(node.options) < 2:
            warnings.append(
                ValidationIssue(
                    code="single_option_node",
                    path=f"nodes.{node_id}.options",
                    message=f"Node {node_id!r} only defines 1 option; menus typically present 2–4 choices.",
                )
            )
        if len(node.options) > 4:
            warnings.append(
                ValidationIssue(
                    code="too_many_options",
                    path=f"nodes.{node_id}.options",
                    message=(
                        f"Node {node_id!r} has {len(node.options)} options; "
                        "<=4 options per spoken prompt reduces caller cognitive load."
                    ),
                )
            )

        words = [w for w in node.script.strip().split() if w]
        if len(words) > 45:
            warnings.append(
                ValidationIssue(
                    code="long_script",
                    path=f"nodes.{node_id}.script",
                    message=f"Node {node_id!r} script is {len(words)} words (>45 words takes >18s to speak).",
                )
            )

        lower_script = node.script.lower()
        for opt in node.options:
            if opt.title.lower() not in lower_script:
                warnings.append(
                    ValidationIssue(
                        code="unmentioned_option",
                        path=f"nodes.{node_id}.options.{opt.id}",
                        message=f"Spoken script in {node_id!r} does not mention option {opt.title!r}.",
                    )
                )
            if not opt.hints.strip():
                warnings.append(
                    ValidationIssue(
                        code="empty_hints",
                        path=f"nodes.{node_id}.options.{opt.id}.hints",
                        message=f"Option {opt.id!r} in {node_id!r} has empty hints; contrastive hints improve Jev separation.",
                    )
                )
            if graph.evals and f"{node_id}:{opt.id}" not in eval_pairs:
                warnings.append(
                    ValidationIssue(
                        code="missing_option_eval",
                        path=f"nodes.{node_id}.options.{opt.id}",
                        message=f"No eval case covers option {opt.id!r} in node {node_id!r}.",
                    )
                )

    if not graph.evals:
        warnings.append(
            ValidationIssue(
                code="no_evals",
                path="evals",
                message="Menu defines no `evals[]` test utterances.",
            )
        )
    elif not has_unclear_eval:
        warnings.append(
            ValidationIssue(
                code="missing_unclear_eval",
                path="evals",
                message="Eval suite has no negative out-of-scope (`expect: \"unclear\"`) test case.",
            )
        )

    return ValidationReport(valid=len(errors) == 0, errors=errors, warnings=warnings)


def _outgoing_node_targets(node: MenuNode) -> list[str]:
    targets: list[str] = []
    for opt in node.options:
        if isinstance(opt.action, GotoAction):
            targets.append(opt.action.target)
        elif isinstance(opt.action, WebhookAction):
            if isinstance(opt.action.next, GotoAction):
                targets.append(opt.action.next.target)
            if isinstance(opt.action.onFailure, FallbackGoto):
                targets.append(opt.action.onFailure.target)
    return targets


def _outgoing_targets(graph: MenuGraph, node_id: str) -> list[str]:
    node = graph.nodes.get(node_id)
    if node is None:
        return []
    targets = _outgoing_node_targets(node)
    if isinstance(graph.fallbackAction, FallbackGoto):
        targets.append(graph.fallbackAction.target)
    if isinstance(graph.globals.operator, GlobalOperatorObject) and isinstance(
        graph.globals.operator.action, FallbackGoto
    ):
        targets.append(graph.globals.operator.action.target)
    return targets


def _node_has_direct_exit(graph: MenuGraph, node: MenuNode) -> bool:
    for opt in node.options:
        if isinstance(
            opt.action,
            (EndCallAction, TransferAction, HandoffLlmAction, ReplyOnlyAction),
        ):
            return True
        if isinstance(opt.action, WebhookAction) and not isinstance(opt.action.next, GotoAction):
            return True
    if graph.fallbackAction is not None and not isinstance(graph.fallbackAction, FallbackGoto):
        return True
    return bool(
        isinstance(graph.globals.operator, GlobalOperatorObject)
        and not isinstance(graph.globals.operator.action, FallbackGoto)
    )
