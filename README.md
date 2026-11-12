# Deterministic Voice IVR (`pipecat-jev` + Studio + Agent Skill)

Build zero-hallucination voice phone menus powered by [TypeSafe Jev](https://docs.typesafe.ai/api/system-one) and run them in any [Pipecat](https://www.pipecat.ai/) `>=1.16` pipeline.

Callers speak naturally (or press keypad digits); Jev classifies intent with calibrated probabilities and optional `noul`/`choice` extraction; TTS speaks only approved verbatim scripts—or hands off open-ended branches (`handoff_llm`) to a downstream specialist LLM.

## What's Inside

| Path | Purpose |
| --- | --- |
| `packages/pipecat-jev/` | Publishable Python package providing `JevMenuProcessor` (`FrameProcessor`), Twilio/Daily SIP transfer adapters, and the non-interactive `jev-ivr` CLI (`schema`, `validate`, `eval`). |
| `skills/design-ivr/` & `.claude-plugin/` | Agent skill (`/jev-ivr:design-ivr`) composed with [`pipecat-ai/skills`](https://github.com/pipecat-ai/skills) (`init`, `deploy`) so AI coding agents can author, self-tune against Jev probabilities, and deploy any IVR. |
| `app/` & `lib/` | Next.js **Deterministic IVR Studio & Multi-Turn Jev Playground** for editing canonical v2 `.menu.json` graphs, recording mic turns via Deepgram, inspecting probability bars, and exporting Pipecat `bot.py` pipelines. |

## 1. Python Package & `jev-ivr` CLI (`packages/pipecat-jev`)

```bash
cd packages/pipecat-jev
uv sync --extra dev

# Print canonical v2 menu.json JSON Schema
uv run jev-ivr schema

# Lint graph structure, cycle exits, DTMF collisions, and voice UX budgets
uv run jev-ivr validate path/to/menu.json --json

# Run tune or holdout evals against TypeSafe Jev (/v1/systemone)
TYPESAFE_API_KEY=... uv run jev-ivr eval path/to/menu.json --split tune --json
TYPESAFE_API_KEY=... uv run jev-ivr eval path/to/menu.json --split holdout --json
```

### Drop Into a Pipecat 1.16 Pipeline

```python
import os
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat_jev import JevMenuProcessor

context = LLMContext()
user_aggregator, assistant_aggregator = LLMContextAggregatorPair(context)

ivr = JevMenuProcessor.from_file("menu.json", api_key=os.environ["TYPESAFE_API_KEY"])

pipeline = Pipeline([
    transport.input(),
    DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"]),
    user_aggregator,
    ivr,  # Sits in the LLM slot (or immediately ahead of an LLMService for `handoff_llm`)
    DeepgramTTSService(api_key=os.environ["DEEPGRAM_API_KEY"], voice="aura-2-asteria-en"),
    transport.output(),
    assistant_aggregator,
])
```

## 2. Agent-Authored IVRs (`pipecat-ai/skills` + `design-ivr`)

Register both plugin marketplaces in Claude Code (or use the skills pre-installed under `.agents/skills/` in OpenCode / Codex / Cursor):

```text
/plugin marketplace add pipecat-ai/skills
/plugin install pipecat@pipecat-skills pipecat-cloud@pipecat-skills

/plugin marketplace add <owner>/voice-ivr
/plugin install jev-ivr@jev-ivr-skills
```

Then ask your agent to scaffold, design, tune against `jev-ivr eval`, and audition over `smallwebrtc` via `/jev-ivr:design-ivr`.

## 3. Web Studio & Playground

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to edit `.menu.json` v2 graphs, test voice or typed turns with live Jev probability bars, and copy ready-to-run Pipecat `bot.py` snippets.

## Tests

```bash
# TypeScript conformance & Studio tests
npm test

# Python schema, validator, evaluator & Pipecat 1.16 frame pipeline tests
cd packages/pipecat-jev && uv run pytest
```
