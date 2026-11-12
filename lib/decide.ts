import { transcribeAudio } from "./deepgram";
import { HttpError } from "./errors";
import { classifyNodeTurn, type NodeClassification, type Turn } from "./jev";
import { hasOwn, type MenuGraph } from "./menu";
import { firstConfident } from "./race";

export type Decision = NodeClassification & {
  path: "text" | "audio";
  ms: number;
  transcript: string;
};

export async function decideFast(args: {
  graph: MenuGraph;
  nodeId?: string;
  stack?: string[];
  unclearStreak?: number;
  extracted?: Record<string, boolean | string>;
  history?: Turn[];
  text?: string;
  audio?: Uint8Array;
  mimeType?: string;
  jevKey: string;
  deepgramKey: string;
  fetchImpl?: typeof fetch;
}): Promise<Decision> {
  const tasks: Promise<Decision>[] = [];
  const text = args.text?.trim() ?? "";
  const nodeId = args.nodeId || args.graph.entry;
  const threshold =
    (hasOwn(args.graph.nodes, nodeId) ? args.graph.nodes[nodeId].confidenceThreshold : undefined) ??
    args.graph.confidenceThreshold;

  if (text) {
    tasks.push(
      timed("text", async () => {
        const result = await classifyNodeTurn({
          apiKey: args.jevKey,
          graph: args.graph,
          nodeId,
          stack: args.stack,
          unclearStreak: args.unclearStreak,
          extracted: args.extracted,
          history: args.history,
          turn: text,
          fetchImpl: args.fetchImpl,
        });
        return { ...result, transcript: text };
      }),
    );
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
        const result = await classifyNodeTurn({
          apiKey: args.jevKey,
          graph: args.graph,
          nodeId,
          stack: args.stack,
          unclearStreak: args.unclearStreak,
          extracted: args.extracted,
          history: args.history,
          turn: transcript,
          fetchImpl: args.fetchImpl,
        });
        return { ...result, transcript };
      }),
    );
  }

  if (tasks.length === 0) {
    throw new HttpError("Type a reply or record one.", 400);
  }

  return firstConfident(tasks, threshold);
}

async function timed(
  path: Decision["path"],
  run: () => Promise<NodeClassification & { transcript: string }>,
): Promise<Decision> {
  const started = Date.now();
  const choice = await run();
  return { ...choice, path, ms: Date.now() - started };
}
