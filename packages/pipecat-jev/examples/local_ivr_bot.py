"""Runnable local Pipecat 1.16 IVR bot example using SmallWebRTC + Deepgram + JevMenuProcessor.

Install optional audio/WebRTC extras and run:
    uv sync --extra deepgram
    TYPESAFE_API_KEY=... DEEPGRAM_API_KEY=... uv run python examples/local_ivr_bot.py
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.workers.runner import WorkerRunner

from pipecat_jev import JevMenuProcessor, SimulatedTransferAdapter

load_dotenv(override=True)

EXAMPLE_MENU = {
    "version": 2,
    "id": "northwind_clinic",
    "name": "Northwind Clinic",
    "entry": "main",
    "confidenceThreshold": 0.55,
    "maxUnclearTurns": 2,
    "fallbackAction": {
        "type": "transfer",
        "target": "+18005550100",
        "reply": "Let me connect you with our front desk.",
    },
    "globals": {"back": True, "repeat": True},
    "nodes": {
        "main": {
            "id": "main",
            "name": "Northwind Clinic",
            "script": "Thanks for calling Northwind Clinic. You can say Appointments, Urgent Care, or Hours.",
            "options": [
                {
                    "id": "appointments",
                    "title": "Appointments",
                    "dtmf": "1",
                    "hints": "Book, reschedule, or cancel a routine checkup",
                    "action": {"type": "goto", "target": "appointments_menu"},
                },
                {
                    "id": "urgent_care",
                    "title": "Urgent Care",
                    "dtmf": "2",
                    "hints": "Severe pain, fever, injury, or same-day nurse triage",
                    "reply": "Connecting you to our triage nurse right away.",
                    "action": {"type": "transfer", "target": "sip:nurse@northwind.example.com"},
                },
                {
                    "id": "hours",
                    "title": "Hours",
                    "dtmf": "3",
                    "hints": "Clinic hours, address, parking, or holiday schedule",
                    "reply": "We are open Monday through Saturday from 8 AM to 6 PM. Goodbye!",
                    "action": {"type": "end_call"},
                },
            ],
        },
        "appointments_menu": {
            "id": "appointments_menu",
            "name": "Appointments",
            "script": "Appointments. You can say New Visit or Cancel Visit.",
            "options": [
                {
                    "id": "new_visit",
                    "title": "New Visit",
                    "hints": "Schedule a new appointment or checkup",
                    "reply": "Connecting you with scheduling.",
                    "action": {"type": "transfer", "target": "+18005550101"},
                },
                {
                    "id": "cancel_visit",
                    "title": "Cancel Visit",
                    "hints": "Cancel or reschedule an existing appointment",
                    "reply": "Connecting you to modify your appointment.",
                    "action": {"type": "transfer", "target": "+18005550102"},
                },
            ],
        },
    },
}


async def run_bot(transport: BaseTransport) -> None:
    stt = DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"])
    tts = DeepgramTTSService(api_key=os.environ["DEEPGRAM_API_KEY"], voice="aura-2-asteria-en")

    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    menu_path = os.environ.get("MENU_JSON_PATH")
    ivr = JevMenuProcessor(
        Path(menu_path) if menu_path else EXAMPLE_MENU,
        api_key=os.environ["TYPESAFE_API_KEY"],
        transfer_adapter=SimulatedTransferAdapter(),
    )

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            ivr,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )

    worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=True))

    @transport.event_handler("on_client_connected")
    async def on_client_connected(_transport, _client):
        logger.info("Caller connected — triggering entry IVR greeting")
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(_transport, _client):
        await worker.cancel()

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()


async def bot(runner_args: RunnerArguments) -> None:
    transport = await create_transport(
        runner_args,
        {"webrtc": lambda: TransportParams(audio_in_enabled=True, audio_out_enabled=True)},
    )
    await run_bot(transport)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
