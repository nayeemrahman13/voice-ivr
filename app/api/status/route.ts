import { customLlmSecret, deepgramKey, jevKey, vapiKey } from "@/lib/env";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    jev: Boolean(jevKey()),
    deepgram: Boolean(deepgramKey()),
    vapi: Boolean(vapiKey()),
    customLlmSecret: Boolean(customLlmSecret()),
  });
}
