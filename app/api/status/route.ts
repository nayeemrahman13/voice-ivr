import { deepgramKey, jevKey } from "@/lib/env";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    jev: Boolean(jevKey()),
    deepgram: Boolean(deepgramKey()),
  });
}
