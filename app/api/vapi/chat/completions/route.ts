import { answerTurn } from "@/lib/answer";
import { completionResponse } from "@/lib/completion";
import { customLlmSecret, jevKey } from "@/lib/env";
import { errorMessage } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let stream = false;
  try {
    const body = await request.json();
    stream = Boolean(body && typeof body === "object" && (body as { stream?: unknown }).stream);
    const spoken = await answerTurn({
      body,
      jevKey: jevKey(),
    });
    return completionResponse(spoken.content, stream);
  } catch (error) {
    console.error(errorMessage(error));
    return completionResponse("Sorry, I didn't catch that. You can say one of the menu options.", stream);
  }
}

function authorized(request: Request): boolean {
  const secret = customLlmSecret();
  if (!secret) return true;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}` || request.headers.get("x-vapi-secret") === secret;
}
