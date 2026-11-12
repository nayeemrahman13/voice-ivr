import { decideFast } from "@/lib/decide";
import { deepgramKey, jevKey } from "@/lib/env";
import { errorMessage, errorStatus, HttpError } from "@/lib/errors";
import { type Turn } from "@/lib/jev";
import { parseMenuGraph, validateMenuGraph } from "@/lib/menu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const graph = parseMenuGraph(body.menu);
    const typed = typeof body.text === "string" ? body.text.trim() : "";
    const audio = decodeAudio(body.audioBase64);

    if (!typed && !audio) {
      throw new HttpError("Type a reply or record one.", 400);
    }

    const nodeId = typeof body.nodeId === "string" && body.nodeId.trim() ? body.nodeId.trim() : graph.entry;
    const stack = Array.isArray(body.stack)
      ? body.stack.filter((s: unknown): s is string => typeof s === "string")
      : nodeId === graph.entry
        ? graph.initialStack ?? []
        : [];
    const unclearStreak = typeof body.unclearStreak === "number" && body.unclearStreak >= 0 ? body.unclearStreak : 0;
    const extracted =
      body.extracted && typeof body.extracted === "object" && !Array.isArray(body.extracted)
        ? (body.extracted as Record<string, boolean | string>)
        : {};
    const history: Turn[] = Array.isArray(body.history)
      ? body.history
          .filter(
            (item: unknown): item is Turn =>
              Boolean(
                item &&
                  typeof item === "object" &&
                  ((item as Turn).role === "user" || (item as Turn).role === "assistant") &&
                  typeof (item as Turn).text === "string",
              ),
          )
          .map((item: Turn) => ({ role: item.role, text: item.text }))
      : [];

    // Note: Outbound webhooks and telephony transfers are NEVER executed in Studio preview (zero SSRF).
    const decision = await decideFast({
      graph,
      nodeId,
      stack,
      unclearStreak,
      extracted,
      history,
      text: typed,
      audio: audio ?? undefined,
      mimeType: typeof body.mimeType === "string" ? body.mimeType : "audio/webm",
      jevKey: jevKey(),
      deepgramKey: deepgramKey(),
    });

    const validation = validateMenuGraph(graph);

    return Response.json({
      ...decision,
      validation,
    });
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
