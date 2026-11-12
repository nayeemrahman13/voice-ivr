---
name: design-ivr
description: Design, lint, self-tune, and wire a deterministic v2 voice IVR graph (`menu.json`) into a Pipecat >=1.16 pipeline using TypeSafe Jev (`pipecat-jev` / `jev-ivr`) and `pipecat-ai/skills`.
---

Design and verify a zero-hallucination voice IVR graph (`version: 2`) powered by TypeSafe Jev, then wire `JevMenuProcessor` into a Pipecat `>=1.16` pipeline ready for local WebRTC audition and Pipecat Cloud deployment.

Read `references/bot-wiring-and-hints.md` before drafting `menu.json` or editing `bot.py`.

## Arguments

```
/jev-ivr:design-ivr [<target-dir>]
```

- `<target-dir>` (optional): Existing Pipecat project directory (containing `server/bot.py` or `pyproject.toml`), or a new directory to scaffold.

---

## Step 1: Detect Project State & Bootstrap `pipecat-jev` First

1. **Check whether a Pipecat project already exists** in `<target-dir>` (or current directory):
   - If the user wants a **new runnable Pipecat bot** and no `server/bot.py` exists yet:
     - Follow the official `pipecat-ai/skills` `init` workflow: invoke `/pipecat:init` if registered in Claude Code, or read and execute `.agents/skills/init/SKILL.md` directly (`pipecat init --list-options` -> non-interactive `pipecat init <project_name> --bot-type <web|telephony> --mode cascade ...`).
     - For telephony bots, recommend adding `--transport smallwebrtc` alongside the telephony transport (e.g., `--transport twilio --transport smallwebrtc`) so the IVR can be auditioned locally in a browser before connecting PSTN numbers.
   - If the user only wants a standalone `.menu.json` file (e.g., for the Next.js Studio), skip `pipecat init`.

2. **Install `pipecat-jev` BEFORE calling `jev-ivr`:**
   - Inside `<project>/server` (or the Python environment):
     - If working inside or alongside a local `voice-ivr` checkout containing `packages/pipecat-jev`, run:
       ```bash
       uv add --editable <path-to-voice-ivr>/packages/pipecat-jev
       ```
     - Otherwise install the published package:
       ```bash
       uv add pipecat-jev
       ```
   - Verify the CLI responds non-interactively and inspect the authoritative schema:
     ```bash
     uv run jev-ivr schema --compact
     ```

---

## Step 2: Clarify Governing IVR Decisions

Ask concise structured questions (use your harness's structured question tool such as `AskUserQuestion` / `question` for 2–4 fixed options; if unavailable, present a short numbered list in chat and wait for the user's reply):

1. **Architecture mode:**
   - **Pure Deterministic IVR** — Every leaf ends with `end_call`, `transfer` (PSTN/SIP), `webhook`, or `reply_only`. No generative LLM runs at call time.
   - **Hybrid Triage -> Specialist LLM** — `JevMenuProcessor` routes front-door menus deterministically, then hands off open-ended intake branches (`handoff_llm`) to a downstream Pipecat `LLMService`.
2. **Unclear-caller fallback (`maxUnclearTurns`, default `2`):**
   - Transfer to a human/front-desk number (`transfer`)
   - Hand off to a general LLM assistant (`handoff_llm`)
   - Politely end the call (`end_call`)
3. **Telephony / action endpoints** (only if `transfer` or `webhook` leaves exist): collect real E.164 phone numbers, SIP URIs, or webhook URLs, or mark explicit placeholders for local `SimulatedTransferAdapter` testing.

---

## Step 3: Draft Canonical v2 `menu.json` + Tune/Holdout Eval Splits

Write `menu.json` (in `<project>/server/menu.json` or the requested path) strictly conforming to `uv run jev-ivr schema`:

- **Voice ergonomics:**
  - Keep each node between **2 and 4 options**; split larger menus into submenus connected via `{ "type": "goto", "target": "<node_id>" }`.
  - Keep `script` natural, concise (`<= 45` words), and explicitly name every option's `title` so callers know what they can say.
  - Use stable snake_case IDs (`^[a-z0-9_]+$`). Never use reserved IDs (`unclear`, `global_back`, `global_repeat`, `global_operator`).
- **Contrastive `hints`:**
  - Describe concrete caller situations and synonyms for each option so sibling options have clear decision boundaries (see `references/bot-wiring-and-hints.md`).
- **Secondary questions (`questions`, optional):**
  - Only use TypeSafe `/v1/systemone` primitives: `type: "noul"` (`0..1` yes/no probability with `yesThreshold` / `noThreshold`, default `0.7` / `0.3`) or `type: "choice"` (`>=2` criteria entries). Never write `type: "boolean"`.
- **Anti-overfitting `evals[]` suite (required):**
  - Populate **both** `"split": "tune"` and `"split": "holdout"` inside `evals[]`:
    - `tune`: `>= 3` realistic, varied caller utterances per option across every node, `>= 2` out-of-scope `"expect": "unclear"` utterances, and `"expect": "global_back"` cases (with `"stack": ["<parent_id>"]`) on deeper nodes.
    - `holdout`: `>= 2` **distinct** caller phrasings per option plus `>= 2` distinct `"unclear"` utterances that you will **not** inspect while rewriting hints.

---

## Step 4: Closed-Loop Validation & Live Jev Tuning

1. **Static graph & UX validation (offline):**
   ```bash
   uv run jev-ivr validate menu.json --json
   ```
   Fix all schema errors, orphan nodes, trapped cycles, DTMF collisions, and unintended UX warnings before running live evals.

2. **Check `TYPESAFE_API_KEY`:**
   - Check whether `TYPESAFE_API_KEY` (or `JEV_API_KEY`) is present in the environment or `.env` (without printing secret values).
   - If missing, **do not claim the IVR is Jev-verified**—tell the user validation passed offline and ask them to set `TYPESAFE_API_KEY` to run live probability verification.

3. **Tune loop (`--split tune`, max 4 iterations):**
   ```bash
   uv run jev-ivr eval menu.json --split tune --json
   ```
   - Inspect `failures[]`: use `probabilities`, `collision_with`, and `margin` to sharpen contrastive `hints` on the colliding option pair.
   - Re-run `--split tune` until `failed == 0` and `coverage_errors == []`.

4. **Holdout acceptance gate (`--split holdout`, single check):**
   ```bash
   uv run jev-ivr eval menu.json --split holdout --json
   ```
   - If holdout fails, generalize the option descriptions/hints rather than copying holdout words verbatim into `hints`, then re-verify both splits.

---

## Step 5: Wire `server/bot.py`, Audition Locally & Deploy

1. **Splice `JevMenuProcessor` into `server/bot.py`** using the exact **Pure IVR** or **Hybrid Triage** template in `references/bot-wiring-and-hints.md`:
   - Place `ivr` **immediately after `user_aggregator`**.
   - **Pure IVR**: Remove `llm` construction, remove the scaffolded `"developer"` kickoff prompt (`context.add_message({"role": "developer", ...})`), keep `await worker.queue_frames([LLMRunFrame()])` so `user_aggregator` emits the initial 0-user-turn `LLMContextFrame` that triggers `ivr`'s entry greeting, and remove unused LLM keys from `.env.example`.
   - **Hybrid Triage**: Keep `llm` immediately after `ivr` so `handoff_llm` transitions seamlessly into `llm` with shared `LLMContext`.
   - **Transfers**: Wire `TwilioTransferAdapter(transport=transport)` for Twilio WebSocket bots, `DailySipTransferAdapter()` for Daily SIP bots, or `SimulatedTransferAdapter()` for local `smallwebrtc` testing.
2. **Refresh lockfile:**
   ```bash
   uv lock
   ```
3. **Local voice audition:**
   - Audition the actual bot by running `uv run bot.py` inside `server/` and connecting via the scaffolded `--transport smallwebrtc` browser UI.
   - Do **not** use `/pipecat-mcp-server:talk` to audition `server/bot.py` (`talk` connects to `pipecat-mcp-server`, not your project's `bot.py`).
4. **Cloud deployment (optional):**
   - When ready to deploy to Pipecat Cloud, hand off to `/pipecat-cloud:deploy` (or follow `.agents/skills/deploy/SKILL.md`).
