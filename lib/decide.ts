import { transcribeAudio } from "./deepgram";
import { HttpError } from "./errors";
import { classifyTurn, type Choice } from "./jev";
import { CONFIDENCE, type Menu } from "./menu";
import { firstConfident } from "./race";

export type Decision = Choice & {
  path: "text" | "audio";
  ms: number;
  transcript?: string;
};

export async function decideFast(args: {
  menu: Menu;
  text?: string;
  audio?: Uint8Array;
  mimeType?: string;
  jevKey: string;
  deepgramKey: string;
  fetchImpl?: typeof fetch;
}): Promise<Decision> {
  const tasks: Promise<Decision>[] = [];
  const text = args.text?.trim() ?? "";

  if (text) {
    tasks.push(timed("text", () => classifyTurn({
      apiKey: args.jevKey,
      menu: args.menu,
      turn: text,
      fetchImpl: args.fetchImpl,
    })));
  }

  if (args.audio && args.audio.byteLength > 0) {
    tasks.push(
      timed("audio", async () => {
        const transcript = await transcribeAudio({
          apiKey: args.deepgramKey,
          audio: args.audio!,
          mimeType: args.mimeType || "audio/webm",
          fetchImpl: args.fetchImpl,
        });
        const choice = await classifyTurn({
          apiKey: args.jevKey,
          menu: args.menu,
          turn: transcript,
          fetchImpl: args.fetchImpl,
        });
        return { ...choice, transcript };
      }),
    );
  }

  if (tasks.length === 0) {
    throw new HttpError("Type a reply or record one.", 400);
  }

  return firstConfident(tasks, CONFIDENCE);
}

async function timed(
  path: Decision["path"],
  run: () => Promise<Choice & { transcript?: string }>,
): Promise<Decision> {
  const started = Date.now();
  const choice = await run();
  return { ...choice, path, ms: Date.now() - started };
}
