"""Async TypeSafe Jev (/v1/systemone) client supporting choice + noul questions."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

import httpx

from .schema import (
    UNCLEAR,
    ChoiceQuestion,
    MenuGraph,
    NoulQuestion,
    SecondaryQuestion,
    SecondaryResult,
    TurnStepResult,
    active_globals_for_node,
    step_menu_turn,
)

SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone"
RETRYABLE_STATUSES = frozenset({429, 502, 503, 504})


class JevClientError(RuntimeError):
    """Raised when Jev returns a non-OK response or times out."""


@dataclass
class NodeClassification:
    step: TurnStepResult
    raw_choice: str
    confidence: float
    probabilities: dict[str, float]
    secondary_answers: dict[str, SecondaryResult]
    resolved_model: str
    latency_ms: float


def build_jev_request(
    *,
    graph: MenuGraph,
    node_id: str,
    stack: list[str] | None = None,
    turn: str,
    history: list[dict[str, str]] | None = None,
    model: str = "jev-latest",
) -> dict[str, Any]:
    node = graph.nodes.get(node_id)
    if node is None:
        raise ValueError(f"Unknown node {node_id!r}.")

    criteria: dict[str, str] = {}
    for opt in node.options:
        parts = [p for p in (opt.title.strip(), opt.hints.strip()) if p]
        criteria[opt.id] = ". ".join(parts)

    for g_id, g_meta in active_globals_for_node(graph, len(stack or [])).items():
        parts = [p for p in (g_meta["title"] or "", g_meta["hints"] or "") if p]
        criteria[g_id] = ". ".join(parts)

    criteria[UNCLEAR] = (
        "None of the options. The caller is unsure, silent, or talking about something else."
    )

    questions: dict[str, Any] = {
        "option": {
            "type": "choice",
            "instructions": (
                'Which option is the caller in `turn` choosing? Use `history` only to resolve '
                'references such as "the first one" or "that one".'
            ),
            "criteria": criteria,
        }
    }

    if node.questions:
        for q_name, q_spec in node.questions.items():
            questions[q_name] = _serialize_secondary_question(q_spec)

    return {
        "model": model,
        "state": {
            "history": [{"role": h["role"], "text": h["text"]} for h in (history or [])],
            "turn": turn,
        },
        "questions": questions,
    }


def _serialize_secondary_question(spec: SecondaryQuestion) -> dict[str, Any]:
    if isinstance(spec, NoulQuestion):
        payload: dict[str, Any] = {"type": "noul", "instructions": spec.instructions}
        if spec.criteria:
            payload["criteria"] = spec.criteria
        return payload
    return {
        "type": "choice",
        "instructions": spec.instructions,
        "criteria": spec.criteria,
    }


def parse_jev_payload(
    *,
    payload: Any,
    graph: MenuGraph,
    node_id: str,
    stack: list[str] | None = None,
    unclear_streak: int = 0,
    extracted: dict[str, bool | str] | None = None,
    latency_ms: float = 0.0,
) -> NodeClassification:
    root = payload if isinstance(payload, dict) else {}
    resolved_model = str(root.get("model") or "jev-latest")
    answers = root.get("answers") if isinstance(root.get("answers"), dict) else {}
    opt_ans = answers.get("option") if isinstance(answers.get("option"), dict) else {}

    raw_choice = opt_ans.get("choice") if isinstance(opt_ans.get("choice"), str) else UNCLEAR
    confidence = (
        float(opt_ans["confidence"])
        if isinstance(opt_ans.get("confidence"), (int, float))
        else 0.0
    )
    raw_probs = opt_ans.get("probabilities")
    probabilities: dict[str, float] = {}
    if isinstance(raw_probs, dict):
        for k, v in raw_probs.items():
            if isinstance(v, (int, float)):
                probabilities[str(k)] = float(v)

    node = graph.nodes[node_id]
    secondary_answers: dict[str, SecondaryResult] = {}
    if node.questions:
        for q_name, q_spec in node.questions.items():
            secondary_answers[q_name] = _parse_secondary_answer(answers.get(q_name), q_spec)

    step = step_menu_turn(
        graph=graph,
        node_id=node_id,
        stack=stack,
        unclear_streak=unclear_streak,
        extracted=extracted,
        choice=raw_choice,
        confidence=confidence,
        secondary_answers=secondary_answers,
    )

    return NodeClassification(
        step=step,
        raw_choice=raw_choice,
        confidence=confidence,
        probabilities=probabilities,
        secondary_answers=secondary_answers,
        resolved_model=resolved_model,
        latency_ms=latency_ms,
    )


def _parse_secondary_answer(raw: Any, spec: SecondaryQuestion) -> SecondaryResult:
    rec = raw if isinstance(raw, dict) else {}
    if isinstance(spec, NoulQuestion):
        noul_val = float(rec["noul"]) if isinstance(rec.get("noul"), (int, float)) else 0.5
        if noul_val >= spec.yesThreshold:
            return SecondaryResult(value=True, raw=noul_val)
        if noul_val <= spec.noThreshold:
            return SecondaryResult(value=False, raw=noul_val)
        return SecondaryResult(value=None, raw=noul_val)

    assert isinstance(spec, ChoiceQuestion)
    choice = rec.get("choice") if isinstance(rec.get("choice"), str) else ""
    conf = float(rec["confidence"]) if isinstance(rec.get("confidence"), (int, float)) else 0.0
    if choice and conf >= spec.confidenceThreshold:
        return SecondaryResult(value=choice, raw=conf)
    return SecondaryResult(value=None, raw=conf)


class JevClient:
    """Async client for TypeSafe `/v1/systemone` with bounded timeout and retry."""

    def __init__(
        self,
        api_key: str,
        *,
        model: str = "jev-latest",
        base_url: str = SYSTEMONE_URL,
        timeout_s: float = 4.0,
        max_retries: int = 1,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        clean_key = api_key.strip()
        if not clean_key:
            raise ValueError("TYPESAFE_API_KEY is required.")
        self._api_key = clean_key
        self._model = model
        self._base_url = base_url
        self._timeout_s = timeout_s
        self._max_retries = max_retries
        self._owns_client = http_client is None
        self._client = http_client or httpx.AsyncClient(timeout=timeout_s)

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def classify_turn(
        self,
        *,
        graph: MenuGraph,
        node_id: str | None = None,
        stack: list[str] | None = None,
        unclear_streak: int = 0,
        extracted: dict[str, bool | str] | None = None,
        turn: str,
        history: list[dict[str, str]] | None = None,
    ) -> NodeClassification:
        clean_turn = turn.strip()
        if not clean_turn:
            raise ValueError("Caller turn text cannot be empty.")

        active_node = node_id or graph.entry
        active_stack = (
            list(stack)
            if stack is not None
            else (list(graph.initialStack or []) if active_node == graph.entry else [])
        )
        req_body = build_jev_request(
            graph=graph,
            node_id=active_node,
            stack=active_stack,
            turn=clean_turn,
            history=history,
            model=self._model,
        )

        started = time.perf_counter()
        last_exc: Exception | None = None

        for attempt in range(self._max_retries + 1):
            try:
                response = await self._client.post(
                    self._base_url,
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                    json=req_body,
                    timeout=self._timeout_s,
                )
                if response.status_code in RETRYABLE_STATUSES and attempt < self._max_retries:
                    await asyncio.sleep(0.15 * (attempt + 1))
                    continue

                payload = None
                try:
                    payload = response.json()
                except ValueError:
                    payload = None

                if not response.is_success:
                    raise JevClientError(_provider_error_message(response.status_code, payload))

                elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
                return parse_jev_payload(
                    payload=payload,
                    graph=graph,
                    node_id=active_node,
                    stack=active_stack,
                    unclear_streak=unclear_streak,
                    extracted=extracted,
                    latency_ms=elapsed_ms,
                )
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_exc = exc
                if attempt < self._max_retries:
                    await asyncio.sleep(0.15 * (attempt + 1))
                    continue
                raise JevClientError(f"Jev request failed: {exc.__class__.__name__}") from exc

        raise JevClientError(f"Jev classification failed: {last_exc}")


def _provider_error_message(status: int, payload: Any) -> str:
    if isinstance(payload, dict):
        msg = payload.get("message") or payload.get("detail")
        if isinstance(msg, str) and msg.strip():
            compact = " ".join(msg.split())[:180]
            return f"Jev returned {status}: {compact}"
    return f"Jev returned {status}."
