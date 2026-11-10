import { answerTurn } from "@/lib/answer";
import { transcribeAudio } from "@/lib/deepgram";
import { deepgramKey, jevKey } from "@/lib/env";
import { errorMessage, errorStatus, HttpError } from "@/lib/errors";
import { followPlace, parseMenu, systemMessage } from "@/lib/menu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const menu = parseMenu(body.menu);
    const typed = typeof body.text === "string" ? body.text.trim() : "";
    const audio = decodeAudio(body.audioBase64);
    let text = typed;
    let path: "text" | "audio" = "text";

    if (!text) {
      if (!audio) throw new HttpError("Type a reply or record one.", 400);
      text = await transcribeAudio({
        apiKey: deepgramKey(),
        audio,
        mimeType: typeof body.mimeType === "string" ? body.mimeType : "audio/webm",
      });
      path = "audio";
    }

    const opening = followPlace(menu, []).menu.script;
    const spoken = await answerTurn({
      body: {
        messages: [
          { role: "system", content: systemMessage(menu) },
          { role: "assistant", content: opening },
          { role: "user", content: text },
        ],
      },
      jevKey: jevKey(),
    });

    return Response.json({ ...spoken, path, transcript: text });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: errorStatus(error) });
  }
}

function decodeAudio(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const audio = Buffer.from(value, "base64");
  if (audio.byteLength > 8_000_000) throw new HttpError("The recording is too large.", 400);
  return audio;
}
