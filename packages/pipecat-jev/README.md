# pipecat-jev

Deterministic voice IVR `FrameProcessor` and `jev-ivr` verification CLI for [Pipecat](https://www.pipecat.ai/), powered by [TypeSafe Jev](https://docs.typesafe.ai/api/system-one).

## Features

- **Zero-hallucination voice menus**: Callers speak naturally; Jev classifies intent with calibrated probabilities; TTS speaks only verbatim scripts.
- **Canonical v2 `.menu.json` graph**: Supports shared submenus, `back`/`repeat`/`operator` globals, DTMF shortcuts, TypeSafe `noul` and `choice` secondary extraction, idempotent webhooks, PSTN/SIP transfers, and downstream `handoff_llm` passthrough.
- **Agent-ready `jev-ivr` CLI**: Non-interactive `jev-ivr schema`, `jev-ivr validate --json`, and `jev-ivr eval --split tune|holdout --json` commands for closed-loop hint tuning.
