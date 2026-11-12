# Pipecat 1.16 Wiring Templates & Contrastive Hint Guide

## 1. Writing High-Separation Jev `hints`

TypeSafe Jev (`POST /v1/systemone`) builds each choice's criterion as `"{title}. {hints}"` alongside an automatic `unclear` bucket. Collisions happen when two options describe vague categories instead of concrete caller intents.

| Weak (Collides) | Strong (Contrastive & Concrete) |
| --- | --- |
| `appointments`: `"Book or change a dental visit"`<br>`emergencies`: `"Urgent dental problem"` | `appointments`: `"Routine cleaning, checkup, exam, reschedule, or non-painful visit"`<br>`emergencies`: `"Severe toothache, broken or chipped tooth, knocked-out tooth, lost crown or filling, bleeding, swelling"` |
| `billing`: `"Questions about money"`<br>`sales`: `"Pricing questions"` | `billing`: `"Existing customer invoice, duplicate charge, refund, payment method, statement balance"`<br>`sales`: `"New account pricing, plan comparison, enterprise quote, product demo"` |

### Rules for Secondary Questions (`questions`)

- Use `type: "noul"` for yes/no facts (`noul` returns `[0, 1]`, where `>= yesThreshold` (`0.70`) stores `true`, `<= noThreshold` (`0.30`) stores `false`, and `0.30..0.70` stays `null` without overwriting earlier facts).
- Use `type: "choice"` when classifying an attribute across 2+ named buckets (e.g., `urgency` or `account_tier`).
- Never name a secondary question `"option"` (reserved for primary routing).

---

## 2. Pure Deterministic IVR `server/bot.py` Pattern (No LLM)

Use this pattern when no option or fallback in `menu.json` uses `handoff_llm`. Removing `llm` avoids requiring unused `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` secrets.

```python
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
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams
from pipecat.workers.runner import WorkerRunner

from pipecat_jev import JevMenuProcessor, SimulatedTransferAdapter, TwilioTransferAdapter

load_dotenv(override=True)
MENU_PATH = Path(__file__).with_name("menu.json")


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments) -> None:
    stt = DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"])
    tts = DeepgramTTSService(api_key=os.environ["DEEPGRAM_API_KEY"], voice="aura-2-asteria-en")

    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    # Select TwilioTransferAdapter when handling a Twilio Media Stream, else SimulatedTransferAdapter
    call_data = getattr(runner_args, "call_data", None)
    transfer_adapter = (
        TwilioTransferAdapter(transport=transport, call_sid=getattr(call_data, "call_id", None))
        if call_data is not None
        else SimulatedTransferAdapter()
    )

    ivr = JevMenuProcessor.from_file(
        MENU_PATH,
        api_key=os.environ["TYPESAFE_API_KEY"],
        transfer_adapter=transfer_adapter,
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
        # LLMUserAggregator converts LLMRunFrame into a 0-user-turn LLMContextFrame,
        # which triggers JevMenuProcessor's entry greeting script.
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(_transport, _client):
        await worker.cancel()

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()
```

---

## 3. Hybrid Triage -> Specialist LLM `server/bot.py` Pattern (`handoff_llm`)

Use this pattern when one or more options or `fallbackAction` use `{"type": "handoff_llm"}`.

- Place `ivr` **immediately before `llm`**:
  ```python
  pipeline = Pipeline(
      [
          transport.input(),
          stt,
          user_aggregator,
          ivr,
          llm,
          tts,
          transport.output(),
          assistant_aggregator,
      ]
  )
  ```
- Leave `"reply": ""` on `handoff_llm` options when you want the specialist `llm` to answer the caller's utterance immediately on the same turn without a double greeting. Set a non-empty `"reply"` only when you want a deterministic bridge line spoken first.
- Do **not** add `context.add_message({"role": "developer", "content": "Start by concisely introducing yourself."})` in `on_client_connected`; `JevMenuProcessor` owns the initial greeting and injects the branch's `systemPrompt` + `{"ivr_route": ..., "extracted": ...}` into `LLMContext` at handoff time.
