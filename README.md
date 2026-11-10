# Phone menu

Build a phone menu and run it as a [Vapi](https://vapi.ai) assistant. You list the options and write the line the agent says for each one. An option can open a nested menu.

On a call, Deepgram Flux listens, [Jev](https://docs.typesafe.ai) picks the stored line for the current menu, and Deepgram speaks that line. The agent does not invent a reply.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

| Variable | Used for |
| --- | --- |
| `TYPESAFE_API_KEY` | Jev classification. `JEV_API_KEY` is also accepted. |
| `DEEPGRAM_API_KEY` | Transcribing a recording in the on-page test. A live Vapi call uses Vapi's Deepgram transcriber and voice. |
| `VAPI_API_KEY` | Creating the assistant from this page. |

## Try a menu

Edit the options, the phrases a caller might say, and the line the agent speaks after Jev picks one. Nested menus have their own script and options.

**Run the turn** sends the current menu to Jev. A typed reply is used as-is. A recording is transcribed with Deepgram first. The page shows the stored line Jev chose and which menu the call is now in.

A menu needs at least two options.

## Put it on a call

The page builds a Vapi assistant:

- Transcriber: Deepgram Flux (`flux-general-en`)
- Model: this app as a custom LLM
- Voice: Deepgram Aura 2 (`asteria`)

**Download assistant** saves that config as JSON. **Create in Vapi** posts it to Vapi and returns a dashboard link.

Vapi calls `{custom LLM base URL}/chat/completions`. The page fills that URL from the current origin. A local address is enough to try a reply on this page. A live call needs a public URL for this server.

## Tests

```bash
npm test
```
