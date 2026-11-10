import { vapiKey } from "@/lib/env";
import { errorMessage, HttpError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const key = vapiKey();
    if (!key) throw new HttpError("Add VAPI_API_KEY to .env.local and restart.", 400);
    const assistant = await request.json();
    if (assistant?.model?.provider !== "custom-llm") {
      throw new HttpError("The module has to use the custom LLM.", 400);
    }

    const response = await fetch("https://api.vapi.ai/assistant", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(assistant),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new HttpError(vapiError(payload, response.status), response.status);
    }
    const id = typeof payload?.id === "string" ? payload.id : "";
    return Response.json({
      id,
      name: payload?.name ?? assistant.name,
      dashboardUrl: id ? `https://dashboard.vapi.ai/assistants/${id}` : "https://dashboard.vapi.ai/assistants",
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 502;
    return Response.json({ error: errorMessage(error) }, { status });
  }
}

function vapiError(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const record = payload as { message?: unknown; error?: unknown };
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
  }
  return `Vapi returned ${status}.`;
}
