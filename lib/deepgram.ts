import { HttpError } from "./errors";
import { providerMessage } from "./jev";

export async function transcribeAudio(args: {
  apiKey: string;
  audio: Uint8Array;
  mimeType: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const apiKey = args.apiKey.trim();
  if (!apiKey) throw new HttpError("Add DEEPGRAM_API_KEY to .env.local and restart.", 400);
  if (args.audio.byteLength === 0) throw new HttpError("The recording was empty.", 400);
  if (args.audio.byteLength > 8_000_000) throw new HttpError("The recording is too large.", 400);

  const mime = args.mimeType.split(";")[0] || "audio/webm";
  const response = await (args.fetchImpl ?? fetch)(
    "https://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true&punctuate=true",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": mime,
      },
      body: new Blob([new Uint8Array(args.audio)], { type: mime }),
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new HttpError(providerMessage("Deepgram", response.status, payload), 502);
  }

  const transcript = readTranscript(payload);
  if (!transcript) throw new HttpError("Deepgram returned an empty transcript.", 502);
  return transcript;
}

function readTranscript(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const results = (payload as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } }).results;
  return results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
}
