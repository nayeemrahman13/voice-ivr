"""End-to-end frame lifecycle probes against the pinned Pipecat 1.16 pipeline."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest
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
    KeypadEntry,
    LLMContextFrame,
    LLMRunFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    UserTurnResponseCancelFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.turns.types import UserTurnSpeculation
from pipecat.utils.asyncio.task_manager import TaskManager
from pipecat.workers.base_worker import WorkerParams

from pipecat_jev.client import JevClient
from pipecat_jev.frames import JevDecisionFrame, JevStateFrame, JevTransferFrame
from pipecat_jev.processor import JevMenuProcessor
from pipecat_jev.schema import parse_menu_graph
from pipecat_jev.transfers import (
    DailySipTransferAdapter,
    FallbackDailySIPReferFrame,
    SimulatedTransferAdapter,
    TransferContext,
    TwilioTransferAdapter,
)

FIXTURES = Path(__file__).resolve().parents[3] / "schemas" / "fixtures"


def graph(name: str = "pure_ivr"):
    return parse_menu_graph(json.loads((FIXTURES / "valid" / f"{name}.json").read_text()))


def payload(choice: str = "help", confidence: float = 0.99):
    return {"model": "runtime-test-model", "answers": {"option": {"choice": choice, "confidence": confidence}}}


class Collector(FrameProcessor):
    """A downstream frame collector that remains inside the real pipeline."""

    def __init__(self):
        super().__init__(name="TestCollector")
        self.frames: list[tuple[Frame, FrameDirection]] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        self.frames.append((frame, direction))
        await self.push_frame(frame, direction)

    def of_type(self, cls: type):
        return [frame for frame, _direction in self.frames if isinstance(frame, cls)]


class MockLLMService(FrameProcessor):
    """Named as an LLM service so the processor's real downstream gate recognizes it."""

    def __init__(self):
        super().__init__(name="MockLLMService")
        self.frames: list[Frame] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        self.frames.append(frame)
        await self.push_frame(frame, direction)


class Runtime:
    def __init__(self, processors: list[FrameProcessor]):
        self.collector = Collector()
        self.worker = PipelineWorker(Pipeline([*processors, self.collector]))
        self.started = asyncio.Event()
        self.errors: list[Frame] = []
        self.run_task: asyncio.Task[Any] | None = None

        @self.worker.event_handler("on_pipeline_started")
        async def pipeline_started(_worker, _frame):
            self.started.set()

        self.worker.add_reached_upstream_filter((ErrorFrame,))

        @self.worker.event_handler("on_frame_reached_upstream")
        async def frame_reached_upstream(_worker, frame):
            if isinstance(frame, ErrorFrame):
                self.errors.append(frame)

        @self.worker.event_handler("on_pipeline_error")
        async def pipeline_error(_worker, frame):
            self.errors.append(frame)

    async def start(self):
        self.run_task = asyncio.create_task(self.worker.run(WorkerParams(task_manager=TaskManager())))
        try:
            await asyncio.wait_for(self.started.wait(), timeout=3)
        except TimeoutError:
            # Startup-gate failures intentionally do not emit on_pipeline_started.
            await asyncio.sleep(0.05)

    async def send(self, frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM):
        await self.worker.queue_frame(frame, direction)

    async def wait_for(self, predicate, timeout: float = 2.0):
        async def poll():
            while not predicate():
                await asyncio.sleep(0.005)
        await asyncio.wait_for(poll(), timeout=timeout)

    async def close(self):
        if self.run_task is None:
            return
        if not self.run_task.done():
            await self.worker.queue_frame(EndFrame())
        try:
            await asyncio.wait_for(self.run_task, timeout=3)
        except (TimeoutError, RuntimeError):
            self.run_task.cancel()
            await asyncio.gather(self.run_task, return_exceptions=True)


async def runtime_with_jev(graph_value, choice="help", **kwargs):
    jev_http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=payload(choice)))
    )
    jev = JevClient("test-key", http_client=jev_http)
    processor = JevMenuProcessor(graph_value, jev_client=jev, **kwargs)
    runtime = Runtime([processor])
    await runtime.start()
    return runtime, processor, jev_http


async def cleanup(runtime: Runtime, *clients: httpx.AsyncClient):
    await runtime.close()
    for client in clients:
        await client.aclose()


@pytest.mark.asyncio
async def test_real_aggregator_kickoff_strips_developer_and_greets():
    ctx = LLMContext()
    ctx.add_message({"role": "developer", "content": "Start by concisely introducing yourself."})
    user_aggregator, _assistant_aggregator = LLMContextAggregatorPair(context=ctx)
    jev_http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=payload()))
    )
    ivr = JevMenuProcessor(graph(), jev_client=JevClient("test", http_client=jev_http))
    runtime = Runtime([user_aggregator, ivr])
    await runtime.start()
    try:
        await runtime.send(LLMRunFrame())
        await runtime.wait_for(lambda: bool(runtime.collector.of_type(TTSSpeakFrame)))
        assert ctx.get_messages() == []
        assert not any("developer" in str(frame) for frame in runtime.collector.of_type(LLMContextFrame))
        assert runtime.collector.of_type(JevStateFrame)[0].script == graph().nodes["main"].script
        assert runtime.collector.of_type(TTSSpeakFrame)[0].text == graph().nodes["main"].script
    finally:
        await cleanup(runtime, jev_http)


def context_with_user(text: str = "I need help") -> LLMContext:
    context = LLMContext()
    context.add_message({"role": "user", "content": text})
    return context


@pytest.mark.asyncio
async def test_speculative_turn_commits_on_user_stop_without_second_context_frame():
    runtime, ivr, jev_http = await runtime_with_jev(graph())
    try:
        await runtime.send(LLMContextFrame(context=context_with_user(), speculation=True))
        await runtime.wait_for(lambda: ivr._staged_payload is not None)
        assert not runtime.collector.of_type(TTSSpeakFrame)
        assert not runtime.collector.of_type(JevDecisionFrame)
        await runtime.send(UserStoppedSpeakingFrame())
        await runtime.wait_for(lambda: bool(runtime.collector.of_type(TTSSpeakFrame)))
        assert runtime.collector.of_type(JevDecisionFrame)[0].outcome_choice == "help"
        assert runtime.collector.of_type(TTSSpeakFrame)[0].text == "Sure."
    finally:
        await cleanup(runtime, jev_http)


@pytest.mark.parametrize("cancel_frame", [UserTurnResponseCancelFrame, InterruptionFrame])
@pytest.mark.asyncio
async def test_speculative_cancel_discards_staged_turn(cancel_frame):
    runtime, ivr, jev_http = await runtime_with_jev(graph())
    try:
        original_node = ivr.current_node_id
        await runtime.send(LLMContextFrame(context=context_with_user(), speculation=True))
        await runtime.wait_for(lambda: ivr._staged_payload is not None)
        await runtime.send(cancel_frame())
        await runtime.send(UserStoppedSpeakingFrame())
        await asyncio.sleep(0.05)
        assert ivr.current_node_id == original_node
        assert not runtime.collector.of_type(JevDecisionFrame)
        assert not runtime.collector.of_type(TTSSpeakFrame)
    finally:
        await cleanup(runtime, jev_http)


def transfer_graph(adapter="twilio_dial"):
    raw = json.loads((FIXTURES / "valid" / "pure_ivr.json").read_text())
    raw["nodes"]["main"]["options"][0].update(
        {"dtmf": "2", "action": {"type": "transfer", "target": "+18005550123", "mode": adapter}}
    )
    return parse_menu_graph(raw)


@pytest.mark.asyncio
async def test_dtmf_transfer_is_nonblocking_and_runs_after_bot_stops():
    adapter = SimulatedTransferAdapter()
    runtime, _ivr, jev_http = await runtime_with_jev(transfer_graph(), transfer_adapter=adapter)
    try:
        await asyncio.wait_for(runtime.send(InputDTMFFrame(button=KeypadEntry.TWO)), timeout=0.2)
        await runtime.wait_for(lambda: bool(runtime.collector.of_type(TTSSpeakFrame)))
        assert runtime.collector.of_type(InterruptionFrame)
        assert runtime.collector.of_type(JevTransferFrame)
        assert adapter.history == []
        await runtime.send(BotStoppedSpeakingFrame(), FrameDirection.UPSTREAM)
        await runtime.wait_for(lambda: bool(adapter.history) and bool(runtime.collector.of_type(EndWorkerFrame)))
        assert adapter.history[0].target == "+18005550123"
    finally:
        await cleanup(runtime, jev_http)


@pytest.mark.asyncio
async def test_real_twilio_serializer_does_not_hang_up_after_transfer():
    requests = []
    redirect_cancel_results = []
    serializer = TwilioFrameSerializer(
        stream_sid="MZ1", call_sid="CA1", account_sid="AC1", auth_token="secret"
    )

    async def twilio_handler(request):
        requests.append(request)
        redirect_cancel_results.append(await serializer.serialize(CancelFrame()))
        return httpx.Response(200, json={"sid": "CA1"})

    twilio_http = httpx.AsyncClient(transport=httpx.MockTransport(twilio_handler))
    hangups = []

    async def hang_up():
        hangups.append(True)

    serializer._hang_up_call = hang_up
    adapter = TwilioTransferAdapter(serializer=serializer, http_client=twilio_http)
    await adapter.execute(TransferContext(target="+18005550123", mode="twilio_dial", node_id="main", option_id="help"))
    assert len(requests) == 1
    request = requests[0]
    assert request.url.path == "/2010-04-01/Accounts/AC1/Calls/CA1.json"
    form = parse_qs(request.content.decode())
    assert form["Twiml"] == ["<Response><Dial>+18005550123</Dial></Response>"]
    assert redirect_cancel_results == [None]
    assert hangups == []
    assert serializer._params.auto_hang_up is False
    await serializer.serialize(EndFrame())
    await serializer.serialize(CancelFrame())
    assert hangups == []
    await twilio_http.aclose()


@pytest.mark.asyncio
async def test_daily_sip_transfer_queues_refer_after_tts():
    adapter = DailySipTransferAdapter(session_id="s1")
    runtime, _ivr, jev_http = await runtime_with_jev(
        transfer_graph("daily_sip_refer"), transfer_adapter=adapter
    )
    try:
        await runtime.send(InputDTMFFrame(button=KeypadEntry.TWO))
        await runtime.wait_for(lambda: bool(runtime.collector.of_type(FallbackDailySIPReferFrame)))
        tts = runtime.collector.of_type(TTSSpeakFrame)[0]
        refer = runtime.collector.of_type(FallbackDailySIPReferFrame)[0]
        tts_index = next(i for i, (f, _d) in enumerate(runtime.collector.frames) if f is tts)
        refer_index = next(i for i, (f, _d) in enumerate(runtime.collector.frames) if f is refer)
        assert tts_index < refer_index
        assert refer.settings == {"toEndPoint": "+18005550123", "sessionId": "s1"}
    finally:
        await cleanup(runtime, jev_http)


@pytest.mark.parametrize("status,expected_reply,expected_failure", [(200, "Success", False), (500, "Try again", True)])
@pytest.mark.asyncio
async def test_webhook_transaction_success_and_failure(status, expected_reply, expected_failure):
    raw = json.loads((FIXTURES / "valid" / "webhook_failure.json").read_text())
    raw["nodes"]["main"]["options"][0]["reply"] = "Success"
    raw["nodes"]["billing"] = {
        "id": "billing",
        "name": "Billing",
        "script": "Billing destination.",
        "options": [{"id": "done", "title": "Done", "hints": "done", "reply": "Done.", "action": {"type": "end_call"}}],
    }
    webhook_action = raw["nodes"]["main"]["options"][0]["action"]
    webhook_action.update(
        {
            "failureReply": "Try again",
            "onFailure": {"type": "end_call", "reply": "Fallback"},
            "next": {"type": "goto", "target": "billing"},
        }
    )
    graph_value = parse_menu_graph(raw)
    calls = []

    def webhook_handler(request):
        calls.append(request)
        return httpx.Response(status)

    webhook_http = httpx.AsyncClient(transport=httpx.MockTransport(webhook_handler))
    jev_http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=payload("help")))
    )
    ivr = JevMenuProcessor(graph_value, jev_client=JevClient("test", http_client=jev_http), webhook_client=webhook_http)
    runtime = Runtime([ivr])
    await runtime.start()
    try:
        await runtime.send(LLMContextFrame(context=context_with_user()))
        await runtime.wait_for(lambda: bool(runtime.collector.of_type(TTSSpeakFrame)))
        spoken = [frame.text for frame in runtime.collector.of_type(TTSSpeakFrame)]
        joined = " ".join(spoken)
        assert expected_reply in joined
        assert ("Success" in joined) is not expected_failure
        assert len(calls) == 1
        assert calls[0].headers.get("Idempotency-Key")
        if expected_failure:
            assert runtime.errors
            assert ivr.mode == "terminal"
        else:
            assert ivr.current_node_id == "billing"
    finally:
        await cleanup(runtime, jev_http, webhook_http)


@pytest.mark.asyncio
async def test_handoff_startup_requires_downstream_llm_and_passthrough_injects_triage_context():
    handoff = graph("handoff_llm")
    missing_runtime = Runtime([JevMenuProcessor(handoff, api_key="test")])
    await missing_runtime.start()
    await asyncio.sleep(0.05)
    assert missing_runtime.errors or any(isinstance(frame, ErrorFrame) for frame, _d in missing_runtime.collector.frames)
    await missing_runtime.close()

    ctx = context_with_user("I need help")
    mock_llm = MockLLMService()
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=payload("help")))
    )
    ivr = JevMenuProcessor(handoff, jev_client=JevClient("test", http_client=http_client))
    runtime = Runtime([ivr, mock_llm])
    await runtime.start()
    try:
        assert not runtime.errors
        await runtime.send(LLMContextFrame(context=ctx))
        await runtime.wait_for(lambda: ivr.mode == "passthrough")
        assert ctx.get_messages()[0]["role"] == "system"
        assert "IVR triage context" in ctx.get_messages()[0]["content"]
        context_frames_before = sum(isinstance(frame, LLMContextFrame) for frame in mock_llm.frames)
        assert context_frames_before == 0
        await runtime.send(LLMContextFrame(context=ctx))
        await runtime.wait_for(
            lambda: sum(isinstance(frame, LLMContextFrame) for frame in mock_llm.frames)
            > context_frames_before
        )
        assert isinstance(mock_llm.frames[-1], LLMContextFrame)
    finally:
        await cleanup(runtime, http_client)


@pytest.mark.asyncio
async def test_transfer_wait_survives_interruption_barge_in():
    adapter = SimulatedTransferAdapter()
    runtime, _ivr, jev_http = await runtime_with_jev(transfer_graph(), transfer_adapter=adapter)
    try:
        await runtime.send(LLMContextFrame(context=context_with_user("transfer me")))
        await runtime.wait_for(lambda: bool(runtime.collector.of_type(TTSSpeakFrame)))
        await runtime.send(InterruptionFrame())
        await runtime.send(BotStoppedSpeakingFrame(), FrameDirection.UPSTREAM)
        await runtime.wait_for(lambda: bool(adapter.history) and bool(runtime.collector.of_type(EndWorkerFrame)))
        assert adapter.history[0].target == "+18005550123"
    finally:
        await cleanup(runtime, jev_http)


@pytest.mark.asyncio
async def test_paused_voice_choice_is_superseded_by_later_dtmf_choice():
    raw = json.loads((FIXTURES / "valid" / "pure_ivr.json").read_text())
    raw["nodes"]["main"]["options"][0].update(
        {"dtmf": "2", "action": {"type": "transfer", "target": "+18005550123", "mode": "custom"}}
    )
    raw["nodes"]["main"]["options"][1]["dtmf"] = "3"
    transfer_adapter = SimulatedTransferAdapter()
    runtime, ivr, jev_http = await runtime_with_jev(
        parse_menu_graph(raw), choice="help", transfer_adapter=transfer_adapter
    )
    option_handler_started = asyncio.Event()
    release_option_handler = asyncio.Event()

    @ivr.on_option("help")
    async def pause_transfer_choice(_event):
        option_handler_started.set()
        await release_option_handler.wait()

    try:
        await runtime.send(LLMContextFrame(context=context_with_user("please transfer me")))
        await asyncio.wait_for(option_handler_started.wait(), timeout=2)

        await runtime.send(InputDTMFFrame(button=KeypadEntry.THREE))
        await runtime.wait_for(
            lambda: any(
                frame.source == "dtmf" and frame.outcome_choice == "other"
                for frame in runtime.collector.of_type(JevDecisionFrame)
            )
        )
        release_option_handler.set()
        await asyncio.sleep(0.05)

        assert [frame.outcome_choice for frame in runtime.collector.of_type(JevDecisionFrame)] == ["help", "other"]
        assert transfer_adapter.history == []
        assert not any(
            isinstance(frame, EndWorkerFrame) and frame.reason.startswith("transferred:")
            for frame in runtime.collector.of_type(EndWorkerFrame)
        )
    finally:
        release_option_handler.set()
        await cleanup(runtime, jev_http)


@pytest.mark.asyncio
async def test_twilio_timeout_keeps_auto_hangup_and_emits_failure_frames():
    def timeout_handler(_request):
        raise httpx.ReadTimeout("Twilio did not respond")

    twilio_http = httpx.AsyncClient(transport=httpx.MockTransport(timeout_handler))
    serializer = TwilioFrameSerializer(
        stream_sid="MZ1", call_sid="CA1", account_sid="AC1", auth_token="secret"
    )
    adapter = TwilioTransferAdapter(serializer=serializer, http_client=twilio_http)
    runtime, _ivr, jev_http = await runtime_with_jev(transfer_graph(), transfer_adapter=adapter)
    try:
        await runtime.send(LLMContextFrame(context=context_with_user("transfer me")))
        await runtime.wait_for(lambda: bool(runtime.collector.of_type(TTSSpeakFrame)))
        await runtime.send(BotStoppedSpeakingFrame(), FrameDirection.UPSTREAM)
        await runtime.wait_for(lambda: any(
            isinstance(frame, EndWorkerFrame) and frame.reason == "transfer_failed"
            for frame in runtime.collector.of_type(EndWorkerFrame)
        ))
        assert serializer._params.auto_hang_up is True
        assert serializer._hangup_attempted is False
        assert runtime.errors
        assert "Twilio transfer request failed (ReadTimeout)" in str(runtime.errors[0].error)
        assert any(
            frame.text == "Sorry, we couldn't complete that transfer."
            for frame in runtime.collector.of_type(TTSSpeakFrame)
        )
    finally:
        await cleanup(runtime, jev_http, twilio_http)


def make_handoff_graph(reply: str = "Sure."):
    raw = json.loads((FIXTURES / "valid" / "handoff_llm.json").read_text())
    raw["nodes"]["main"]["options"][0]["reply"] = reply
    raw["nodes"]["main"]["options"][0]["dtmf"] = "2"
    raw["nodes"]["main"]["options"][0]["action"]["systemPrompt"] = "Use the triage notes."
    return parse_menu_graph(raw)


@pytest.mark.asyncio
async def test_eager_handoff_persists_context_on_real_shared_aggregator():
    context = LLMContext()
    user_aggregator, _assistant_aggregator = LLMContextAggregatorPair(context=context)
    mock_llm = MockLLMService()
    jev_http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=payload("help")))
    )
    ivr = JevMenuProcessor(make_handoff_graph(), jev_client=JevClient("test", http_client=jev_http))
    runtime = Runtime([user_aggregator, ivr, mock_llm])
    await runtime.start()
    try:
        # This drives the same real aggregator method and SystemFrame ordering as eager inference.
        await user_aggregator._run_speculative_inference(UserTurnSpeculation(text="I need help"))
        await user_aggregator.broadcast_frame(UserStoppedSpeakingFrame)
        await runtime.wait_for(lambda: ivr.mode == "passthrough")
        await runtime.wait_for(lambda: len(context.get_messages()) > 0)
        system = context.get_messages()[0]
        assert system["role"] == "system"
        assert "Use the triage notes." in system["content"]
        assert "ivr_route" in system["content"] and "extracted" in system["content"]
        context_count = sum(isinstance(frame, LLMContextFrame) for frame in mock_llm.frames)
        await runtime.send(LLMContextFrame(context=context))
        await runtime.wait_for(
            lambda: sum(isinstance(frame, LLMContextFrame) for frame in mock_llm.frames) > context_count
        )
        forwarded_context = next(frame.context for frame in reversed(mock_llm.frames) if isinstance(frame, LLMContextFrame))
        assert forwarded_context.get_messages()[0]["content"] == system["content"]
    finally:
        await cleanup(runtime, jev_http)


@pytest.mark.parametrize("with_aggregator", [True, False])
@pytest.mark.asyncio
async def test_dtmf_handoff_without_bridge_reply_immediately_sends_context(with_aggregator):
    graph_value = make_handoff_graph(reply="")
    mock_llm = MockLLMService()
    processors: list[FrameProcessor] = []
    context = LLMContext()
    user_aggregator = None
    if with_aggregator:
        user_aggregator, _assistant_aggregator = LLMContextAggregatorPair(context=context)
        processors.append(user_aggregator)
    jev_http = httpx.AsyncClient(transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=payload())))
    ivr = JevMenuProcessor(graph_value, jev_client=JevClient("test", http_client=jev_http))
    processors.extend([ivr, mock_llm])
    runtime = Runtime(processors)
    await runtime.start()
    try:
        await runtime.send(InputDTMFFrame(button=KeypadEntry.TWO))
        await runtime.wait_for(lambda: any(isinstance(frame, LLMContextFrame) for frame in mock_llm.frames))
        handed_context = next(frame.context for frame in mock_llm.frames if isinstance(frame, LLMContextFrame))
        messages = handed_context.get_messages()
        assert messages[0]["role"] == "system"
        assert "Use the triage notes." in messages[0]["content"]
        assert any(m.get("role") == "user" and "Selected option" in m.get("content", "") for m in messages)
        if not with_aggregator:
            assert all("content" in message and "text" not in message for message in messages)
            assert any(
                message.get("role") == "user" and "[DTMF:2]" in message["content"]
                for message in messages
            )
            assert all(
                message.get("content") == graph_value.nodes["main"].script
                for message in messages
                if message.get("role") == "assistant"
            )
        if with_aggregator:
            await runtime.wait_for(lambda: bool(context.get_messages()))
            assert context.get_messages()[0]["content"] == messages[0]["content"]
    finally:
        await cleanup(runtime, jev_http)


@pytest.mark.asyncio
async def test_cancelled_eager_prediction_can_be_replaced_by_same_text_turn():
    runtime, _ivr, jev_http = await runtime_with_jev(graph())
    text = "I need help"
    try:
        await runtime.send(LLMContextFrame(context=context_with_user(text), speculation=True))
        await runtime.wait_for(lambda: _ivr._staged_payload is not None)
        await runtime.send(UserTurnResponseCancelFrame())
        await runtime.send(LLMContextFrame(context=context_with_user(text), speculation=False))
        await runtime.wait_for(lambda: bool(runtime.collector.of_type(JevDecisionFrame)))
        await runtime.wait_for(lambda: bool(runtime.collector.of_type(TTSSpeakFrame)))
        assert runtime.collector.of_type(JevDecisionFrame)[0].transcript == text
        assert runtime.collector.of_type(TTSSpeakFrame)[0].text == "Sure."
    finally:
        await cleanup(runtime, jev_http)


@pytest.mark.asyncio
async def test_immediate_eager_confirmation_survives_system_frame_priority_race():
    runtime, _ivr, jev_http = await runtime_with_jev(graph())
    try:
        await runtime.worker.queue_frames(
            [
                LLMContextFrame(context=context_with_user("I need help"), speculation=True),
                UserStoppedSpeakingFrame(),
            ]
        )
        await runtime.wait_for(lambda: bool(runtime.collector.of_type(JevDecisionFrame)))
        await runtime.wait_for(lambda: bool(runtime.collector.of_type(TTSSpeakFrame)))
        assert runtime.collector.of_type(JevDecisionFrame)[0].outcome_choice == "help"

        # Exercise the aggregator's speculative inference + immediate system broadcast path too.
        await cleanup(runtime, jev_http)
        context = LLMContext()
        user_aggregator, _assistant_aggregator = LLMContextAggregatorPair(context=context)
        jev_http2 = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=payload()))
        )
        ivr2 = JevMenuProcessor(graph(), jev_client=JevClient("test", http_client=jev_http2))
        runtime2 = Runtime([user_aggregator, ivr2])
        await runtime2.start()
        try:
            await user_aggregator._run_speculative_inference(UserTurnSpeculation(text="I need help"))
            await user_aggregator.broadcast_frame(UserStoppedSpeakingFrame)
            await runtime2.wait_for(lambda: bool(runtime2.collector.of_type(JevDecisionFrame)))
            await runtime2.wait_for(lambda: bool(runtime2.collector.of_type(TTSSpeakFrame)))
            assert runtime2.collector.of_type(JevDecisionFrame)[0].outcome_choice == "help"
        finally:
            await cleanup(runtime2, jev_http2)
    finally:
        if runtime.run_task is not None and not runtime.run_task.done():
            await cleanup(runtime, jev_http)


@pytest.mark.asyncio
async def test_interruption_withdraws_queued_speculative_context_before_user_stop():
    runtime, ivr, jev_http = await runtime_with_jev(graph())
    try:
        await runtime.worker.queue_frames(
            [
                LLMContextFrame(context=context_with_user("I need help"), speculation=True),
                InterruptionFrame(),
                UserStoppedSpeakingFrame(),
            ]
        )
        await runtime.wait_for(
            lambda: bool(runtime.collector.of_type(InterruptionFrame))
            and bool(runtime.collector.of_type(UserStoppedSpeakingFrame))
            and ivr._voided_speculation_debt == 0
        )
        await asyncio.sleep(0.05)
        assert not runtime.collector.of_type(JevDecisionFrame)
        assert not runtime.collector.of_type(TTSSpeakFrame)
        assert not any(
            isinstance(frame, EndWorkerFrame) and frame.reason == "end_call"
            for frame in runtime.collector.of_type(EndWorkerFrame)
        )
    finally:
        await cleanup(runtime, jev_http)


@pytest.mark.asyncio
async def test_user_cancel_withdraws_older_speculative_context_even_when_it_arrives_later():
    runtime, ivr, jev_http = await runtime_with_jev(graph())
    try:
        old_context = LLMContextFrame(context=context_with_user("I need help"), speculation=True)
        withdrawal = UserTurnResponseCancelFrame()
        await runtime.worker.queue_frames([old_context, withdrawal, UserStoppedSpeakingFrame()])

        await runtime.wait_for(
            lambda: bool(runtime.collector.of_type(UserTurnResponseCancelFrame))
            and bool(runtime.collector.of_type(UserStoppedSpeakingFrame))
        )
        await asyncio.sleep(0.05)
        assert not runtime.collector.of_type(JevDecisionFrame)
        assert not runtime.collector.of_type(TTSSpeakFrame)
        assert not any(
            isinstance(frame, EndWorkerFrame) and frame.reason == "end_call"
            for frame in runtime.collector.of_type(EndWorkerFrame)
        )
        assert ivr.mode == "menu"
    finally:
        await cleanup(runtime, jev_http)


@pytest.mark.asyncio
async def test_user_cancel_does_not_withdraw_newer_speculative_context():
    runtime, _ivr, jev_http = await runtime_with_jev(graph())
    try:
        await runtime.worker.queue_frames(
            [
                UserTurnResponseCancelFrame(),
                LLMContextFrame(context=context_with_user("I need help"), speculation=True),
                UserStoppedSpeakingFrame(),
            ]
        )

        await runtime.wait_for(
            lambda: len(runtime.collector.of_type(JevDecisionFrame)) == 1
            and len(runtime.collector.of_type(TTSSpeakFrame)) == 1
        )
        assert runtime.collector.of_type(JevDecisionFrame)[0].outcome_choice == "help"
        assert runtime.collector.of_type(TTSSpeakFrame)[0].text == "Sure."
    finally:
        await cleanup(runtime, jev_http)


def reply_only_graph():
    raw = json.loads((FIXTURES / "valid" / "pure_ivr.json").read_text())
    raw["nodes"]["main"]["options"][0]["action"] = {"type": "reply_only"}
    return parse_menu_graph(raw)


@pytest.mark.asyncio
async def test_interruption_does_not_withdraw_context_constructed_after_it():
    runtime, ivr, jev_http = await runtime_with_jev(reply_only_graph())
    try:
        await runtime.worker.queue_frames(
            [
                InterruptionFrame(),
                LLMContextFrame(context=context_with_user("I need help"), speculation=True),
                UserStoppedSpeakingFrame(),
            ]
        )
        await runtime.wait_for(
            lambda: len(runtime.collector.of_type(JevDecisionFrame)) == 1
            and len(runtime.collector.of_type(TTSSpeakFrame)) == 1
        )
        assert runtime.collector.of_type(JevDecisionFrame)[0].outcome_choice == "help"
        assert runtime.collector.of_type(TTSSpeakFrame)[0].text == "Sure."
        assert ivr._voided_speculation_debt == 0
    finally:
        await cleanup(runtime, jev_http)


@pytest.mark.asyncio
async def test_repeated_interruption_does_not_poison_next_speculative_turn():
    runtime, ivr, jev_http = await runtime_with_jev(reply_only_graph())
    try:
        await runtime.worker.queue_frames(
            [
                LLMContextFrame(context=context_with_user("I need help"), speculation=True),
                InterruptionFrame(),
                InterruptionFrame(),
                UserStoppedSpeakingFrame(),
            ]
        )
        await runtime.wait_for(
            lambda: len(runtime.collector.of_type(InterruptionFrame)) == 2
            and bool(runtime.collector.of_type(UserStoppedSpeakingFrame))
        )
        await asyncio.sleep(0.05)
        assert not runtime.collector.of_type(JevDecisionFrame)
        assert not runtime.collector.of_type(TTSSpeakFrame)
        assert ivr._voided_speculation_debt == 0

        await runtime.worker.queue_frames(
            [
                UserStartedSpeakingFrame(),
                LLMContextFrame(context=context_with_user("I need help"), speculation=True),
                UserStoppedSpeakingFrame(),
            ]
        )
        await runtime.wait_for(
            lambda: len(runtime.collector.of_type(JevDecisionFrame)) == 1
            and len(runtime.collector.of_type(TTSSpeakFrame)) == 1
        )
        assert runtime.collector.of_type(JevDecisionFrame)[0].outcome_choice == "help"
        assert runtime.collector.of_type(TTSSpeakFrame)[0].text == "Sure."
        assert ivr._voided_speculation_debt == 0
    finally:
        await cleanup(runtime, jev_http)


@pytest.mark.asyncio
async def test_real_aggregator_barge_in_then_speculation_commits_new_turn():
    context = LLMContext()
    user_aggregator, _assistant_aggregator = LLMContextAggregatorPair(context=context)
    jev_http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=payload()))
    )
    ivr = JevMenuProcessor(reply_only_graph(), jev_client=JevClient("test", http_client=jev_http))
    runtime = Runtime([user_aggregator, ivr])
    await runtime.start()
    try:
        await user_aggregator.broadcast_frame(UserStartedSpeakingFrame)
        await user_aggregator.broadcast_interruption()
        await user_aggregator._run_speculative_inference(UserTurnSpeculation(text="I need help"))
        await user_aggregator.broadcast_frame(UserStoppedSpeakingFrame)

        await runtime.wait_for(
            lambda: len(runtime.collector.of_type(JevDecisionFrame)) == 1
            and len(runtime.collector.of_type(TTSSpeakFrame)) == 1
        )
        assert runtime.collector.of_type(JevDecisionFrame)[0].outcome_choice == "help"
        assert runtime.collector.of_type(TTSSpeakFrame)[0].text == "Sure."
        assert ivr._voided_speculation_debt == 0
    finally:
        await cleanup(runtime, jev_http)


@pytest.mark.asyncio
async def test_webhook_failure_goto_ancestor_pops_existing_stack_entry():
    raw = json.loads((FIXTURES / "valid" / "webhook_failure.json").read_text())
    raw["nodes"]["main"]["options"][0]["action"] = {"type": "goto", "target": "billing"}
    raw["nodes"]["billing"] = {
        "id": "billing",
        "name": "Billing",
        "script": "Billing menu.",
        "options": [{
            "id": "webhook", "title": "Webhook", "hints": "webhook", "reply": "",
            "action": {
                "type": "webhook", "url": "https://example.test/fail",
                "next": {"type": "end_call"},
                "onFailure": {"type": "goto", "target": "main"},
            },
        }],
    }
    graph_value = parse_menu_graph(raw)
    webhook_http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(500))
    )
    jev_http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=payload("webhook")))
    )
    ivr = JevMenuProcessor(graph_value, jev_client=JevClient("test", http_client=jev_http), webhook_client=webhook_http)
    runtime = Runtime([ivr])
    await runtime.start()
    try:
        # Begin inside the child with its existing parent stack, as after a prior goto.
        ivr._current_node_id = "billing"
        ivr._stack = ["main"]
        await runtime.send(
            LLMContextFrame(context=context_with_user("submit request")), FrameDirection.DOWNSTREAM
        )
        await runtime.wait_for(lambda: ivr.current_node_id == "main" and not ivr.stack)
        assert ivr.current_node_id == "main"
        assert ivr.stack == []
    finally:
        await cleanup(runtime, jev_http, webhook_http)


@pytest.mark.asyncio
async def test_long_speech_transfer_waits_for_bot_stopped_after_started_event():
    adapter = SimulatedTransferAdapter()
    runtime, _ivr, jev_http = await runtime_with_jev(
        transfer_graph(), transfer_adapter=adapter,
        post_speech_drain_timeout=0.05, max_speech_duration_timeout=1.0,
    )
    try:
        await runtime.send(LLMContextFrame(context=context_with_user("transfer me")))
        await runtime.wait_for(lambda: bool(runtime.collector.of_type(TTSSpeakFrame)))
        await runtime.send(BotStartedSpeakingFrame(), FrameDirection.UPSTREAM)
        await asyncio.sleep(0.12)
        assert adapter.history == []
        await runtime.send(BotStoppedSpeakingFrame(), FrameDirection.UPSTREAM)
        await runtime.wait_for(lambda: bool(adapter.history) and bool(runtime.collector.of_type(EndWorkerFrame)))
        assert adapter.history[0].target == "+18005550123"
    finally:
        await cleanup(runtime, jev_http)
