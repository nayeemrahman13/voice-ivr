"""Pipecat >=1.16 deterministic IVR FrameProcessor powered by TypeSafe Jev."""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import httpx
from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    EndFrame,
    EndWorkerFrame,
    ErrorFrame,
    Frame,
    InputDTMFFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMMessagesAppendFrame,
    LLMMessagesTransformFrame,
    StartFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    UserTurnResponseCancelFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from .client import JevClient, JevClientError, NodeClassification
from .frames import JevDecisionFrame, JevStateFrame, JevTransferFrame
from .schema import (
    UNCLEAR,
    EndCallAction,
    FallbackAction,
    FallbackEndCall,
    FallbackGoto,
    FallbackHandoffLlm,
    FallbackTransfer,
    GotoAction,
    HandoffLlmAction,
    MenuGraph,
    ReplyOnlyAction,
    TransferAction,
    TurnStepResult,
    WebhookAction,
    active_globals_for_node,
    parse_menu_graph,
    push_node_stack,
    reprompt_text,
    step_menu_turn,
)
from .transfers import (
    SimulatedTransferAdapter,
    TransferAdapter,
    TransferContext,
)


@dataclass
class OptionSelectedEvent:
    """Payload passed to `@ivr.on_option(...)` callbacks."""

    node_id: str
    option_id: str
    transcript: str
    confidence: float
    extracted: dict[str, bool | str]
    call_metadata: dict[str, Any]


OptionHandler = Callable[[OptionSelectedEvent], Awaitable[None]]
TransferHandler = Callable[[TransferContext], Awaitable[None]]


def graph_uses_handoff_llm(graph: MenuGraph) -> bool:
    if isinstance(graph.fallbackAction, FallbackHandoffLlm):
        return True
    if (
        graph.globals.operator
        and not isinstance(graph.globals.operator, bool)
        and isinstance(graph.globals.operator.action, FallbackHandoffLlm)
    ):
        return True
    for node in graph.nodes.values():
        for opt in node.options:
            if isinstance(opt.action, HandoffLlmAction):
                return True
            if isinstance(opt.action, WebhookAction) and (
                isinstance(opt.action.next, HandoffLlmAction)
                or isinstance(opt.action.onFailure, FallbackHandoffLlm)
            ):
                return True
    return False


class JevMenuProcessor(FrameProcessor):
    """Deterministic voice IVR processor for Pipecat >=1.16 pipelines.

    Place immediately after `user_aggregator` (replacing `llm` in Pure IVR bots, or
    immediately preceding `llm` in Hybrid `handoff_llm` bots). Also supports standalone
    pipelines without `LLMContextAggregatorPair` via `TranscriptionFrame` fallback.
    """

    def __init__(
        self,
        menu: MenuGraph | dict[str, Any] | str | Path,
        *,
        api_key: str | None = None,
        jev_client: JevClient | None = None,
        transfer_adapter: TransferAdapter | None = None,
        webhook_client: httpx.AsyncClient | None = None,
        call_metadata: dict[str, Any] | None = None,
        session_id: str | None = None,
        post_speech_drain_timeout: float = 5.0,
        max_speech_duration_timeout: float = 60.0,
        require_downstream_llm_check: bool = True,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        if isinstance(menu, MenuGraph):
            self._graph = menu
        elif isinstance(menu, (str, Path)):
            self._graph = MenuGraph.from_file(menu)
        else:
            self._graph = parse_menu_graph(menu)

        if jev_client is not None:
            self._jev = jev_client
            self._owns_jev = False
        else:
            resolved_key = (
                api_key
                or os.environ.get("TYPESAFE_API_KEY")
                or os.environ.get("JEV_API_KEY")
                or ""
            )
            self._jev = JevClient(resolved_key)
            self._owns_jev = True

        self._owns_webhook_client = webhook_client is None
        self._webhook_client = webhook_client or httpx.AsyncClient(timeout=5.0)
        self._transfer_adapter = transfer_adapter
        self._call_metadata: dict[str, Any] = dict(call_metadata or {})
        self._session_id = session_id or str(uuid.uuid4())
        self._post_speech_drain_timeout = post_speech_drain_timeout
        self._max_speech_duration_timeout = max_speech_duration_timeout
        self._require_downstream_llm_check = require_downstream_llm_check

        # Per-call state reducer fields
        self._mode: Literal["menu", "passthrough", "terminal"] = "menu"
        self._greeted: bool = False
        self._saw_context_aggregator: bool = False
        self._current_node_id: str = self._graph.entry
        self._stack: list[str] = list(self._graph.initialStack or [])
        self._unclear_streak: int = 0
        self._extracted: dict[str, bool | str] = {}
        self._standalone_history: list[dict[str, str]] = []

        # Monotonic turn generation + SpeculationGate-aligned turn tracking
        self._turn_gen: int = 0
        self._turn_ended: bool = False
        self._voided_speculation_debt: int = 0
        # Highest withdrawal frame id. Speculative contexts constructed earlier
        # are void even if they reach this processor after the withdrawal.
        self._speculation_withdrawn_through: int = 0
        self._classify_task: asyncio.Task[Any] | None = None
        self._staged_gen: int | None = None
        self._staged_payload: (
            tuple[
                NodeClassification,
                str,
                LLMContextFrame | None,
                tuple[str, int, str] | None,
                Literal["voice", "dtmf", "error_fallback"],
            ]
            | None
        ) = None
        self._commit_on_stage_ready: bool = False
        self._last_committed_signature: tuple[str, int, str] | None = None

        # Non-blocking speech lifecycle tracking & owned task tracking
        self._bot_started_event = asyncio.Event()
        self._bot_stopped_event = asyncio.Event()
        self._owned_tasks: set[asyncio.Task[Any]] = set()
        self._option_handlers: dict[str, OptionHandler] = {}
        self._transfer_handler: TransferHandler | None = None

    @classmethod
    def from_file(cls, path: str | Path, **kwargs: Any) -> JevMenuProcessor:
        return cls(MenuGraph.from_file(path), **kwargs)

    @property
    def current_node_id(self) -> str:
        return self._current_node_id

    @property
    def stack(self) -> list[str]:
        return list(self._stack)

    @property
    def extracted(self) -> dict[str, bool | str]:
        return dict(self._extracted)

    @property
    def mode(self) -> Literal["menu", "passthrough", "terminal"]:
        return self._mode

    def greet_frames(self) -> list[Frame]:
        """Explicit greeting frames for standalone pipelines without `LLMContextAggregatorPair`."""
        self._greeted = True
        entry_node = self._graph.nodes[self._current_node_id]
        self._standalone_history.append({"role": "assistant", "text": entry_node.script})
        return [
            JevStateFrame(
                node_id=entry_node.id,
                stack=list(self._stack),
                script=entry_node.script,
                extracted=dict(self._extracted),
            ),
            TTSSpeakFrame(text=entry_node.script, append_to_context=True),
        ]

    def on_option(self, key: str) -> Callable[[OptionHandler], OptionHandler]:
        """Register an async callback for `'option_id'` or `'node_id/option_id'`."""

        def decorator(fn: OptionHandler) -> OptionHandler:
            self._option_handlers[key] = fn
            return fn

        return decorator

    def on_transfer(self, fn: TransferHandler) -> TransferHandler:
        """Register a custom async transfer handler overriding `transfer_adapter`."""
        self._transfer_handler = fn
        return fn

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        # 1. Lifecycle & teardown frames
        if isinstance(frame, StartFrame):
            await self.push_frame(frame, direction)
            if (
                self._require_downstream_llm_check
                and graph_uses_handoff_llm(self._graph)
                and not self._has_downstream_llm()
            ):
                err_msg = (
                    f"MenuGraph {self._graph.id!r} uses `handoff_llm`, "
                    "but no downstream LLM processor is wired after JevMenuProcessor."
                )
                await self.push_frame(ErrorFrame(error=err_msg), FrameDirection.UPSTREAM)
                raise RuntimeError(err_msg)
            return

        if isinstance(frame, (CancelFrame, EndFrame)):
            await self._cancel_owned_tasks()
            await self.push_frame(frame, direction)
            return

        # 2. Bot speaking lifecycle events wake non-blocking post-speech transfer tasks
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_started_event.set()
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_stopped_event.set()
            await self.push_frame(frame, direction)
            return

        # 3. Once handed off to downstream LLM, pass everything straight through
        if self._mode == "passthrough":
            await self.push_frame(frame, direction)
            return

        # 4. Once a terminal action (`end_call` or `transfer`) has committed, protect its execution
        # from caller barge-in interruptions while ignoring further caller inputs.
        if self._mode == "terminal":
            if not isinstance(
                frame,
                (
                    LLMContextFrame,
                    TranscriptionFrame,
                    InputDTMFFrame,
                    InterruptionFrame,
                    UserTurnResponseCancelFrame,
                ),
            ):
                await self.push_frame(frame, direction)
            return

        # 5. User turn start/stop/cancel SystemFrames (may arrive ahead of queued LLMContextFrame)
        if isinstance(frame, UserStartedSpeakingFrame):
            self._turn_ended = False
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, (InterruptionFrame, UserTurnResponseCancelFrame)):
            # Record the ordering boundary before invalidating in-flight work.
            # The speculative context may still be upstream of this processor.
            self._note_speculation_withdrawal(frame)
            self._invalidate_inflight_turn()
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, UserStoppedSpeakingFrame):
            self._turn_ended = True
            await self.push_frame(frame, direction)
            if self._mode == "menu" and self._staged_gen == self._turn_gen:
                if self._staged_payload is not None:
                    classification, transcript, ctx_frame, turn_sig, source = self._staged_payload
                    gen = self._turn_gen
                    self._staged_payload = None
                    self._staged_gen = None
                    self._commit_on_stage_ready = False
                    self._spawn_task(
                        self._commit_classification(
                            gen,
                            classification,
                            transcript,
                            ctx_frame,
                            turn_sig=turn_sig,
                            source=source,
                        )
                    )
                else:
                    self._commit_on_stage_ready = True
            return

        # 6. Non-blocking DTMF fast-path (never awaits speech drain inside SystemFrame dispatch)
        if isinstance(frame, InputDTMFFrame):
            digit = frame.button.value
            matched = self._match_dtmf_choice(digit)
            if matched is not None:
                self._invalidate_inflight_turn()
                gen = self._turn_gen
                self._spawn_task(self._handle_dtmf_choice(gen, matched, digit))
            return

        # 7. Primary Pipecat 1.16 turn path: `LLMContextFrame` from `LLMUserAggregator`
        if isinstance(frame, LLMContextFrame):
            self._saw_context_aggregator = True
            messages = list(frame.context.get_messages())
            user_indices = [
                idx
                for idx, m in enumerate(messages)
                if isinstance(m, dict)
                and m.get("role") == "user"
                and _extract_content_text(m.get("content"))
            ]

            # Initial 0-user-turn context emitted when `LLMUserAggregator` consumes `LLMRunFrame`
            if not user_indices:
                if not self._greeted:
                    cleaned = [
                        m
                        for m in messages
                        if not (isinstance(m, dict) and m.get("role") == "developer")
                    ]
                    if len(cleaned) != len(messages):
                        frame.context.set_messages(cleaned)
                    self._greeted = True
                    self._spawn_task(self._emit_entry_greeting())
                return

            last_user_idx = user_indices[-1]
            user_text = _extract_content_text(messages[last_user_idx].get("content"))
            history = _extract_turn_history(messages[:last_user_idx])
            turn_sig = (self._current_node_id, len(user_indices), user_text)

            if frame.speculation:
                # A withdrawal can be processed before this context is queued here.
                # Frame ids increase at construction, so a lower id is the withdrawn one.
                if frame.id < self._speculation_withdrawn_through:
                    return
                if self._voided_speculation_debt > 0:
                    self._voided_speculation_debt -= 1
                    return

                # If UserStoppedSpeakingFrame already arrived on the SystemFrame lane ahead of this
                # queued frame (`_turn_ended` is True), treat as already confirmed!
                if self._turn_ended:
                    if self._last_committed_signature == turn_sig:
                        return
                    self._invalidate_inflight_turn()
                    gen = self._turn_gen
                    self._classify_task = self._spawn_task(
                        self._run_committed_turn(gen, user_text, history, frame, turn_sig)
                    )
                    return

                self._cancel_classify_only()
                self._turn_gen += 1
                gen = self._turn_gen
                self._staged_gen = gen
                self._staged_payload = None
                self._commit_on_stage_ready = False
                self._classify_task = self._spawn_task(
                    self._run_speculative_turn(gen, user_text, history, frame, turn_sig)
                )
            else:
                self._voided_speculation_debt = 0
                if self._last_committed_signature == turn_sig:
                    return
                self._invalidate_inflight_turn()
                gen = self._turn_gen
                self._classify_task = self._spawn_task(
                    self._run_committed_turn(gen, user_text, history, frame, turn_sig)
                )
            return

        # 8. Standalone fallback when used without `LLMContextAggregatorPair`
        if isinstance(frame, TranscriptionFrame) and not self._saw_context_aggregator:
            text = frame.text.strip()
            if text:
                self._invalidate_inflight_turn()
                gen = self._turn_gen
                history = list(self._standalone_history)
                turn_sig = (self._current_node_id, len(history) + 1, text)
                self._classify_task = self._spawn_task(
                    self._run_committed_turn(gen, text, history, None, turn_sig)
                )
            return

        # Forward all other frames unchanged
        await self.push_frame(frame, direction)

    async def cleanup(self) -> None:
        await self._cancel_owned_tasks()
        if self._owns_jev:
            await self._jev.aclose()
        if self._owns_webhook_client:
            await self._webhook_client.aclose()
        await super().cleanup()

    def _spawn_task(self, coro: Awaitable[Any]) -> asyncio.Task[Any]:
        task = asyncio.create_task(coro)  # type: ignore[arg-type]
        self._owned_tasks.add(task)
        task.add_done_callback(self._on_task_done)
        return task

    def _on_task_done(self, task: asyncio.Task[Any]) -> None:
        self._owned_tasks.discard(task)
        if not task.cancelled():
            exc = task.exception()
            if exc is not None:
                logger.error(f"JevMenuProcessor task failed: {exc}")

    def _cancel_classify_only(self) -> None:
        if self._classify_task is not None and not self._classify_task.done():
            self._classify_task.cancel()
        self._classify_task = None

    def _invalidate_inflight_turn(self) -> None:
        self._turn_gen += 1
        self._staged_gen = None
        self._staged_payload = None
        self._commit_on_stage_ready = False
        self._cancel_classify_only()

    def _note_speculation_withdrawal(self, withdrawal: Frame) -> None:
        """Void speculative contexts constructed before `withdrawal`.

        UserTurnResponseCancelFrame can arrive while this processor's queues
        are still empty. Remembering the withdrawal id rejects that older
        context when it shows up later, without voiding one constructed after.
        """
        self._speculation_withdrawn_through = max(
            self._speculation_withdrawn_through, withdrawal.id
        )

    def _menu_turn_superseded(self, gen: int) -> bool:
        """True once a newer input was accepted before this menu choice committed."""
        return gen != self._turn_gen or self._mode != "menu"

    async def _cancel_owned_tasks(self) -> None:
        self._invalidate_inflight_turn()
        pending = [t for t in list(self._owned_tasks) if not t.done()]
        for t in pending:
            t.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        self._owned_tasks.clear()

    def _has_downstream_llm(self) -> bool:
        cur = getattr(self, "_next", None)
        while cur is not None:
            cls_name = cur.__class__.__name__.lower()
            if "llm" in cls_name and "aggregator" not in cls_name and "jev" not in cls_name:
                return True
            if hasattr(cur, "_process_context") or hasattr(cur, "register_function"):
                return True
            cur = getattr(cur, "_next", None)
        return False

    def _has_upstream_user_aggregator(self) -> bool:
        cur = getattr(self, "_prev", None)
        while cur is not None:
            if hasattr(cur, "transform_messages") and hasattr(cur, "push_context_frame"):
                return True
            cur = getattr(cur, "_prev", None)
        return False

    def _match_dtmf_choice(self, digit: str) -> str | None:
        node = self._graph.nodes[self._current_node_id]
        for opt in node.options:
            if opt.dtmf == digit:
                return opt.id
        for g_id, g_meta in active_globals_for_node(self._graph, len(self._stack)).items():
            if g_meta.get("dtmf") == digit:
                return g_id
        return None

    async def _emit_entry_greeting(self) -> None:
        node = self._graph.nodes[self._current_node_id]
        self._standalone_history.append({"role": "assistant", "text": node.script})
        await self.push_frame(
            JevStateFrame(
                node_id=node.id,
                stack=list(self._stack),
                script=node.script,
                extracted=dict(self._extracted),
            )
        )
        await self.push_frame(TTSSpeakFrame(text=node.script, append_to_context=True))

    async def _handle_dtmf_choice(self, gen: int, matched_choice: str, digit: str) -> None:
        if gen != self._turn_gen or self._mode != "menu":
            return
        await self.push_frame(InterruptionFrame())
        step = step_menu_turn(
            graph=self._graph,
            node_id=self._current_node_id,
            stack=self._stack,
            unclear_streak=self._unclear_streak,
            extracted=self._extracted,
            choice=matched_choice,
            confidence=1.0,
        )
        classification = NodeClassification(
            step=step,
            raw_choice=matched_choice,
            confidence=1.0,
            probabilities={matched_choice: 1.0},
            secondary_answers={},
            resolved_model="dtmf",
            latency_ms=0.0,
        )
        await self._commit_classification(
            gen,
            classification,
            f"[DTMF:{digit}]",
            None,
            turn_sig=None,
            source="dtmf",
        )

    async def _classify_safely(
        self,
        user_text: str,
        history: list[dict[str, str]],
    ) -> tuple[NodeClassification, Literal["voice", "error_fallback"]]:
        try:
            result = await self._jev.classify_turn(
                graph=self._graph,
                node_id=self._current_node_id,
                stack=self._stack,
                unclear_streak=self._unclear_streak,
                extracted=self._extracted,
                turn=user_text,
                history=history,
            )
            return result, "voice"
        except JevClientError as exc:
            await self.push_frame(ErrorFrame(error=str(exc)), FrameDirection.UPSTREAM)
            fallback_step = step_menu_turn(
                graph=self._graph,
                node_id=self._current_node_id,
                stack=self._stack,
                unclear_streak=self._unclear_streak,
                extracted=self._extracted,
                choice=UNCLEAR,
                confidence=0.0,
            )
            return (
                NodeClassification(
                    step=fallback_step,
                    raw_choice=UNCLEAR,
                    confidence=0.0,
                    probabilities={},
                    secondary_answers={},
                    resolved_model="error_fallback",
                    latency_ms=0.0,
                ),
                "error_fallback",
            )

    async def _run_speculative_turn(
        self,
        gen: int,
        user_text: str,
        history: list[dict[str, str]],
        ctx_frame: LLMContextFrame,
        turn_sig: tuple[str, int, str],
    ) -> None:
        classification, source = await self._classify_safely(user_text, history)
        if gen != self._turn_gen or self._mode != "menu":
            return
        self._classify_task = None
        if self._commit_on_stage_ready or self._turn_ended:
            self._staged_gen = None
            self._staged_payload = None
            self._commit_on_stage_ready = False
            self._spawn_task(
                self._commit_classification(
                    gen,
                    classification,
                    user_text,
                    ctx_frame,
                    turn_sig=turn_sig,
                    source=source,
                )
            )
        else:
            # Do NOT set _last_committed_signature while merely staged; withdrawal must allow same-text commit
            self._staged_payload = (classification, user_text, ctx_frame, turn_sig, source)

    async def _run_committed_turn(
        self,
        gen: int,
        user_text: str,
        history: list[dict[str, str]],
        ctx_frame: LLMContextFrame | None,
        turn_sig: tuple[str, int, str],
    ) -> None:
        classification, source = await self._classify_safely(user_text, history)
        if gen != self._turn_gen or self._mode != "menu":
            return
        # Detach _classify_task before spawning committed step so post-commit speech drain is protected
        self._classify_task = None
        self._spawn_task(
            self._commit_classification(
                gen,
                classification,
                user_text,
                ctx_frame,
                turn_sig=turn_sig,
                source=source,
            )
        )

    async def _commit_classification(
        self,
        gen: int,
        classification: NodeClassification,
        transcript: str,
        ctx_frame: LLMContextFrame | None,
        *,
        turn_sig: tuple[str, int, str] | None = None,
        source: Literal["voice", "dtmf", "error_fallback"] = "voice",
    ) -> None:
        if gen != self._turn_gen or self._mode != "menu":
            return

        self._turn_ended = False
        if turn_sig is not None:
            self._last_committed_signature = turn_sig

        origin_node_id = self._current_node_id
        step = classification.step
        action = step.terminal_action

        # If action is a WebhookAction, execute & verify 2xx BEFORE speaking success reply!
        if isinstance(action, WebhookAction):
            await self._execute_webhook_transaction(
                gen=gen,
                origin_node_id=origin_node_id,
                classification=classification,
                transcript=transcript,
                ctx_frame=ctx_frame,
                webhook=action,
                source=source,
            )
            return

        await self._apply_committed_step(
            gen=gen,
            origin_node_id=origin_node_id,
            classification=classification,
            step=step,
            transcript=transcript,
            ctx_frame=ctx_frame,
            source=source,
        )

    async def _execute_webhook_transaction(
        self,
        *,
        gen: int,
        origin_node_id: str,
        classification: NodeClassification,
        transcript: str,
        ctx_frame: LLMContextFrame | None,
        webhook: WebhookAction,
        source: Literal["voice", "dtmf", "error_fallback"],
    ) -> None:
        step = classification.step
        idem_key = f"{self._session_id}:{gen}:{step.outcome_choice}"
        headers = {
            "Content-Type": "application/json",
            "Idempotency-Key": idem_key,
            **(webhook.headers or {}),
        }
        payload = {
            "menu_id": self._graph.id,
            "session_id": self._session_id,
            "turn_gen": gen,
            "node_id": origin_node_id,
            "option_id": step.outcome_choice,
            "transcript": transcript,
            "confidence": classification.confidence,
            "extracted": step.extracted,
            "call_metadata": self._call_metadata,
        }

        ok = False
        err_detail = ""
        try:
            resp = await self._webhook_client.request(
                webhook.method,
                webhook.url,
                headers=headers,
                json=payload,
                timeout=webhook.timeoutMs / 1000.0,
            )
            ok = resp.is_success
            if not ok:
                err_detail = f"Webhook returned {resp.status_code}"
        except (httpx.HTTPError, ValueError) as exc:
            ok = False
            err_detail = f"Webhook failed: {exc.__class__.__name__}"

        if gen != self._turn_gen or self._mode != "menu":
            return

        if ok:
            next_act = webhook.next
            if isinstance(next_act, GotoAction):
                target_node = self._graph.nodes[next_act.target]
                combined_reply = " ".join(
                    p for p in (step.spoken_reply.strip(), target_node.script.strip()) if p
                )
                resolved_step = TurnStepResult(
                    outcome_choice=step.outcome_choice,
                    matched_title=step.matched_title,
                    unclear=False,
                    spoken_reply=combined_reply,
                    next_node_id=target_node.id,
                    next_stack=step.next_stack,
                    next_unclear_streak=0,
                    extracted=step.extracted,
                    terminal_action=None,
                )
            else:
                resolved_step = TurnStepResult(
                    outcome_choice=step.outcome_choice,
                    matched_title=step.matched_title,
                    unclear=False,
                    spoken_reply=step.spoken_reply,
                    next_node_id=origin_node_id,
                    next_stack=list(self._stack),
                    next_unclear_streak=0,
                    extracted=step.extracted,
                    terminal_action=next_act,
                )
            await self._apply_committed_step(
                gen=gen,
                origin_node_id=origin_node_id,
                classification=classification,
                step=resolved_step,
                transcript=transcript,
                ctx_frame=ctx_frame,
                source=source,
            )
            return

        # Webhook failed: emit ErrorFrame and run failureReply + cycle-safe stack update
        await self.push_frame(ErrorFrame(error=err_detail), FrameDirection.UPSTREAM)
        failure_action: FallbackAction | None = webhook.onFailure or self._graph.fallbackAction
        node = self._graph.nodes[origin_node_id]
        failure_line = (
            (webhook.failureReply or "").strip()
            or (failure_action.reply.strip() if failure_action and failure_action.reply else "")
            or reprompt_text([o.title for o in node.options])
        )

        if isinstance(failure_action, FallbackGoto):
            target_node = self._graph.nodes[failure_action.target]
            failed_step = TurnStepResult(
                outcome_choice=step.outcome_choice,
                matched_title="Webhook Failure",
                unclear=True,
                spoken_reply=" ".join(
                    p for p in (failure_line, target_node.script.strip()) if p
                ),
                next_node_id=target_node.id,
                next_stack=push_node_stack(self._stack, origin_node_id, target_node.id),
                next_unclear_streak=self._unclear_streak + 1,
                extracted=step.extracted,
                terminal_action=None,
            )
        else:
            failed_step = TurnStepResult(
                outcome_choice=step.outcome_choice,
                matched_title="Webhook Failure",
                unclear=True,
                spoken_reply=failure_line,
                next_node_id=origin_node_id,
                next_stack=list(self._stack),
                next_unclear_streak=self._unclear_streak + 1,
                extracted=step.extracted,
                terminal_action=failure_action,
            )

        await self._apply_committed_step(
            gen=gen,
            origin_node_id=origin_node_id,
            classification=classification,
            step=failed_step,
            transcript=transcript,
            ctx_frame=ctx_frame,
            source="error_fallback",
        )

    async def _apply_committed_step(
        self,
        *,
        gen: int,
        origin_node_id: str,
        classification: NodeClassification,
        step: TurnStepResult,
        transcript: str,
        ctx_frame: LLMContextFrame | None,
        source: Literal["voice", "dtmf", "error_fallback"],
    ) -> None:
        if gen != self._turn_gen or self._mode != "menu":
            return

        prev_node_id = self._current_node_id
        self._current_node_id = step.next_node_id
        self._stack = list(step.next_stack)
        self._unclear_streak = step.next_unclear_streak
        self._extracted = dict(step.extracted)

        if not self._saw_context_aggregator:
            self._standalone_history.append({"role": "user", "text": transcript})
            if step.spoken_reply:
                self._standalone_history.append({"role": "assistant", "text": step.spoken_reply})

        await self.push_frame(
            JevDecisionFrame(
                node_id=origin_node_id,
                source=source,
                transcript=transcript,
                raw_choice=classification.raw_choice,
                outcome_choice=step.outcome_choice,
                confidence=classification.confidence,
                probabilities=dict(classification.probabilities),
                unclear=step.unclear,
                spoken_reply=step.spoken_reply,
                next_node_id=step.next_node_id,
                next_stack=list(step.next_stack),
                extracted=dict(step.extracted),
                resolved_model=classification.resolved_model,
                latency_ms=classification.latency_ms,
            )
        )
        if self._menu_turn_superseded(gen):
            return

        # Invoke registered `@ivr.on_option` callbacks if matched.
        # A newer DTMF/voice decision can commit while a handler is awaiting; do not
        # execute this choice's action after that. Terminal mode, once set below, is
        # what protects an already committed transfer from barge-in.
        if not step.unclear:
            for key in (f"{origin_node_id}/{step.outcome_choice}", step.outcome_choice):
                handler = self._option_handlers.get(key)
                if handler is not None:
                    await handler(
                        OptionSelectedEvent(
                            node_id=origin_node_id,
                            option_id=step.outcome_choice,
                            transcript=transcript,
                            confidence=classification.confidence,
                            extracted=dict(step.extracted),
                            call_metadata=dict(self._call_metadata),
                        )
                    )
                    if self._menu_turn_superseded(gen):
                        return

        if self._menu_turn_superseded(gen):
            return

        action = step.terminal_action

        # Non-terminal menu navigation / reprompt / reply_only
        if action is None or isinstance(action, ReplyOnlyAction):
            if self._current_node_id != prev_node_id:
                new_node = self._graph.nodes[self._current_node_id]
                await self.push_frame(
                    JevStateFrame(
                        node_id=new_node.id,
                        stack=list(self._stack),
                        script=new_node.script,
                        extracted=dict(self._extracted),
                    )
                )
            if step.spoken_reply:
                await self.push_frame(TTSSpeakFrame(text=step.spoken_reply, append_to_context=True))
            return

        # Downstream LLM handoff (updates authoritative shared context via upstream aggregator when present)
        if isinstance(action, (HandoffLlmAction, FallbackHandoffLlm)):
            self._mode = "passthrough"
            await self._execute_handoff_llm(
                ctx_frame=ctx_frame,
                origin_node_id=origin_node_id,
                step=step,
                transcript=transcript,
                system_prompt=action.systemPrompt,
                source=source,
            )
            return

        # Graceful hangup (`end_call`)
        if isinstance(action, (EndCallAction, FallbackEndCall)):
            self._mode = "terminal"
            if step.spoken_reply:
                tts_frame = TTSSpeakFrame(text=step.spoken_reply, append_to_context=True)
                tts_frame.interruptible = False
                await self.push_frame(tts_frame)
            await self.push_frame(EndWorkerFrame(reason="end_call"))
            return

        # Telephony transfer (`transfer`)
        if isinstance(action, (TransferAction, FallbackTransfer)):
            self._mode = "terminal"
            mode_str = action.mode or "custom"
            meta = dict(action.metadata or {})
            await self.push_frame(
                JevTransferFrame(
                    target=action.target,
                    mode=mode_str,
                    node_id=origin_node_id,
                    option_id=step.outcome_choice,
                    extracted=dict(step.extracted),
                    metadata=meta,
                )
            )
            transfer_ctx = TransferContext(
                target=action.target,
                mode=mode_str,
                node_id=origin_node_id,
                option_id=step.outcome_choice,
                extracted=dict(step.extracted),
                metadata=meta,
                call_metadata=dict(self._call_metadata),
                push_frame=self.push_frame,
            )

            adapter = self._transfer_adapter or SimulatedTransferAdapter()

            if self._transfer_handler is None and adapter.uses_ordered_frames:
                if step.spoken_reply:
                    tts_frame = TTSSpeakFrame(text=step.spoken_reply, append_to_context=True)
                    tts_frame.interruptible = False
                    await self.push_frame(tts_frame)
                await adapter.execute(transfer_ctx)
                return

            if step.spoken_reply:
                await self._push_uninterruptible_and_drain(step.spoken_reply)

            try:
                if self._transfer_handler is not None:
                    await self._transfer_handler(transfer_ctx)
                else:
                    await adapter.execute(transfer_ctx)
            except Exception as exc:  # noqa: BLE001 — guard user @ivr.on_transfer callbacks without catching CancelledError
                await self.push_frame(ErrorFrame(error=str(exc)), FrameDirection.UPSTREAM)
                err_tts = TTSSpeakFrame(
                    text="Sorry, we couldn't complete that transfer.",
                    append_to_context=True,
                )
                err_tts.interruptible = False
                await self.push_frame(err_tts)
                await self.push_frame(EndWorkerFrame(reason="transfer_failed"))
                return

            await self.push_frame(EndWorkerFrame(reason=f"transferred:{action.target}"))

    async def _push_uninterruptible_and_drain(self, text: str) -> None:
        """Speak uninterruptible text and wait for playback completion without cutting off long prompts."""
        self._bot_started_event.clear()
        self._bot_stopped_event.clear()

        tts_frame = TTSSpeakFrame(text=text, append_to_context=True)
        tts_frame.interruptible = False
        await self.push_frame(tts_frame)

        started_task = asyncio.create_task(self._bot_started_event.wait())
        stopped_task = asyncio.create_task(self._bot_stopped_event.wait())
        try:
            await asyncio.wait(
                {started_task, stopped_task},
                timeout=self._post_speech_drain_timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if self._bot_stopped_event.is_set():
                return
            if self._bot_started_event.is_set():
                # Output transport actively emits speaking events; allow full utterance playback
                try:
                    await asyncio.wait_for(
                        self._bot_stopped_event.wait(),
                        timeout=self._max_speech_duration_timeout,
                    )
                except TimeoutError:
                    pass
        finally:
            started_task.cancel()
            stopped_task.cancel()
            await asyncio.gather(started_task, stopped_task, return_exceptions=True)

    async def _execute_handoff_llm(
        self,
        *,
        ctx_frame: LLMContextFrame | None,
        origin_node_id: str,
        step: TurnStepResult,
        transcript: str,
        system_prompt: str | None,
        source: Literal["voice", "dtmf", "error_fallback"],
    ) -> None:
        route_summary = json.dumps(
            {
                "ivr_route": [*self._stack, origin_node_id, step.outcome_choice],
                "extracted": step.extracted,
            }
        )
        prompt_parts = [
            p.strip()
            for p in (
                system_prompt or "",
                f"IVR triage context: {route_summary}",
            )
            if p and p.strip()
        ]
        sys_msg = {"role": "system", "content": "\n\n".join(prompt_parts)}
        has_bridge_speech = bool(step.spoken_reply)
        dtmf_user_msg = (
            {"role": "user", "content": f"Selected option: {step.matched_title}"}
            if source == "dtmf"
            else None
        )

        # When wired after `LLMUserAggregator`, mutate the authoritative shared LLMContext via
        # upstream `LLMMessagesTransformFrame` so eager provisional contexts never drop instructions.
        if self._has_upstream_user_aggregator():

            def _transform_shared_context(messages: list[Any]) -> list[Any]:
                cleaned = [
                    m
                    for m in messages
                    if not (isinstance(m, dict) and m.get("role") == "developer")
                ]
                if dtmf_user_msg is not None:
                    cleaned = [*cleaned, dtmf_user_msg]
                return [sys_msg, *cleaned]

            await self.push_frame(
                LLMMessagesTransformFrame(
                    transform=_transform_shared_context,
                    run_llm=not has_bridge_speech,
                ),
                FrameDirection.UPSTREAM,
            )
            if has_bridge_speech:
                await self.push_frame(TTSSpeakFrame(text=step.spoken_reply, append_to_context=True))
            return

        # Standalone pipeline without `LLMUserAggregator`
        if ctx_frame is not None:
            existing = list(ctx_frame.context.get_messages())
            ctx_frame.context.set_messages([sys_msg, *existing])
            if has_bridge_speech:
                await self.push_frame(TTSSpeakFrame(text=step.spoken_reply, append_to_context=True))
            else:
                ctx_frame.speculation = False
                await self.push_frame(ctx_frame)
            return

        fallback_msgs: list[Any] = [
            sys_msg,
            *_chat_messages_from_history(self._standalone_history),
            dtmf_user_msg or {"role": "user", "content": transcript},
        ]
        if has_bridge_speech:
            await self.push_frame(LLMMessagesAppendFrame(messages=fallback_msgs, run_llm=False))
            await self.push_frame(TTSSpeakFrame(text=step.spoken_reply, append_to_context=True))
        else:
            await self.push_frame(LLMContextFrame(context=LLMContext(messages=fallback_msgs)))


def _chat_messages_from_history(history: list[dict[str, str]]) -> list[dict[str, str]]:
    """Jev history is `{role, text}`; Pipecat/OpenAI chat messages require `{role, content}`."""
    messages: list[dict[str, str]] = []
    for item in history:
        role = item.get("role")
        if role not in ("system", "user", "assistant"):
            continue
        text = item.get("text")
        if not isinstance(text, str):
            content = item.get("content")
            text = content if isinstance(content, str) else ""
        if not text:
            continue
        messages.append({"role": role, "content": text})
    return messages


def _extract_content_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return " ".join(parts).strip()
    return ""


def _extract_turn_history(messages: list[Any]) -> list[dict[str, str]]:
    history: list[dict[str, str]] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role not in ("user", "assistant"):
            continue
        text = _extract_content_text(msg.get("content"))
        if text:
            history.append({"role": role, "text": text})
    return history
