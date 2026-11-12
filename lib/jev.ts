import { HttpError } from "./errors";
import {
  activeGlobalsForNode,
  CONFIDENCE,
  hasOwn,
  NOUL_NO_THRESHOLD,
  NOUL_YES_THRESHOLD,
  setOwn,
  stepMenuTurn,
  type MenuGraph,
  type SecondaryQuestion,
  type SecondaryResult,
  type TurnStepResult,
  UNCLEAR,
} from "./menu";

export type Turn = {
  role: "user" | "assistant";
  text: string;
};

export type NodeClassification = TurnStepResult & {
  rawChoice: string;
  confidence: number;
  probabilities: Record<string, number>;
  secondaryAnswers: Record<string, SecondaryResult>;
  resolvedModel: string;
};

export function buildJevGraphRequest(args: {
  graph: MenuGraph;
  nodeId: string;
  stack?: string[];
  turn: string;
  history?: Turn[];
  model?: string;
}) {
  const node = hasOwn(args.graph.nodes, args.nodeId) ? args.graph.nodes[args.nodeId] : undefined;
  if (!node) {
    throw new HttpError(`Unknown node '${args.nodeId}'.`, 400);
  }

  const criteria: Record<string, string> = {};
  for (const option of node.options) {
    setOwn(criteria, option.id, [option.title, option.hints].filter(Boolean).join(". "));
  }

  const globals = activeGlobalsForNode(args.graph, args.stack?.length ?? 0);
  for (const [gId, gMeta] of Object.entries(globals)) {
    setOwn(criteria, gId, [gMeta.title, gMeta.hints].filter(Boolean).join(". "));
  }

  setOwn(
    criteria,
    UNCLEAR,
    "None of the options. The caller is unsure, silent, or talking about something else.",
  );

  const questions: Record<string, unknown> = {};
  setOwn(questions, "option", {
    type: "choice",
    instructions:
      'Which option is the caller in `turn` choosing? Use `history` only to resolve references such as "the first one" or "that one".',
    criteria,
  });

  if (node.questions) {
    for (const [qName, qSpec] of Object.entries(node.questions)) {
      setOwn(questions, qName, serializeSecondaryQuestion(qSpec));
    }
  }

  return {
    model: args.model || "jev-latest",
    state: {
      history: (args.history ?? []).map((item) => ({ role: item.role, text: item.text })),
      turn: args.turn,
    },
    questions,
  };
}

function serializeSecondaryQuestion(q: SecondaryQuestion): Record<string, unknown> {
  if (q.type === "noul") {
    return {
      type: "noul",
      instructions: q.instructions,
      ...(q.criteria && Object.keys(q.criteria).length > 0 ? { criteria: q.criteria } : {}),
    };
  }
  return {
    type: "choice",
    instructions: q.instructions,
    criteria: q.criteria,
  };
}

export function parseGraphPayload(args: {
  payload: unknown;
  graph: MenuGraph;
  nodeId: string;
  stack?: string[];
  unclearStreak?: number;
  extracted?: Record<string, boolean | string>;
}): NodeClassification {
  const root = record(args.payload);
  const resolvedModel = typeof root.model === "string" && root.model ? root.model : "jev-latest";
  const answers = record(root.answers);
  const optionAns = record(answers.option);
  const rawChoice = typeof optionAns.choice === "string" ? optionAns.choice : UNCLEAR;
  const confidence = typeof optionAns.confidence === "number" ? optionAns.confidence : 0;
  const probabilities = numberMap(optionAns.probabilities);

  const node = hasOwn(args.graph.nodes, args.nodeId) ? args.graph.nodes[args.nodeId] : undefined;
  const secondaryAnswers: Record<string, SecondaryResult> = {};
  if (node?.questions) {
    for (const [qName, qSpec] of Object.entries(node.questions)) {
      const rawAns = hasOwn(answers, qName) ? answers[qName] : undefined;
      setOwn(secondaryAnswers, qName, parseSecondaryAnswer(rawAns, qSpec));
    }
  }

  const stepped = stepMenuTurn({
    graph: args.graph,
    nodeId: args.nodeId,
    stack: args.stack,
    unclearStreak: args.unclearStreak,
    extracted: args.extracted,
    choice: rawChoice,
    confidence,
    secondaryAnswers,
  });

  return {
    ...stepped,
    rawChoice,
    confidence,
    probabilities,
    secondaryAnswers,
    resolvedModel,
  };
}

function parseSecondaryAnswer(raw: unknown, spec: SecondaryQuestion): SecondaryResult {
  const rec = record(raw);
  if (spec.type === "noul") {
    const noul = typeof rec.noul === "number" ? rec.noul : 0.5;
    const yesCut = spec.yesThreshold ?? NOUL_YES_THRESHOLD;
    const noCut = spec.noThreshold ?? NOUL_NO_THRESHOLD;
    if (noul >= yesCut) return { value: true, raw: noul };
    if (noul <= noCut) return { value: false, raw: noul };
    return { value: null, raw: noul };
  }
  const choice = typeof rec.choice === "string" ? rec.choice : "";
  const conf = typeof rec.confidence === "number" ? rec.confidence : 0;
  const cut = spec.confidenceThreshold ?? CONFIDENCE;
  if (choice && conf >= cut) return { value: choice, raw: conf };
  return { value: null, raw: conf };
}

export async function classifyNodeTurn(args: {
  apiKey: string;
  graph: MenuGraph;
  nodeId?: string;
  stack?: string[];
  unclearStreak?: number;
  extracted?: Record<string, boolean | string>;
  turn: string;
  history?: Turn[];
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<NodeClassification> {
  const apiKey = args.apiKey.trim();
  if (!apiKey) throw new HttpError("Add TYPESAFE_API_KEY to .env.local and restart.", 400);
  const turn = args.turn.trim();
  if (!turn) throw new HttpError("There is no caller text to classify.", 400);

  const nodeId = args.nodeId || args.graph.entry;
  const stack = args.stack ?? (nodeId === args.graph.entry ? args.graph.initialStack ?? [] : []);

  const response = await (args.fetchImpl ?? fetch)("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      buildJevGraphRequest({
        graph: args.graph,
        nodeId,
        stack,
        turn,
        history: args.history,
        model: args.model,
      }),
    ),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new HttpError(providerMessage("Jev", response.status, payload), 502);
  }

  return parseGraphPayload({
    payload,
    graph: args.graph,
    nodeId,
    stack,
    unclearStreak: args.unclearStreak,
    extracted: args.extracted,
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberMap(value: unknown): Record<string, number> {
  const source = record(value);
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === "number") setOwn(result, key, entry);
  }
  return result;
}

export function providerMessage(name: string, status: number, payload: unknown): string {
  const detail = record(payload);
  const message =
    (typeof detail.message === "string" && detail.message) ||
    (typeof detail.detail === "string" && detail.detail) ||
    "";
  const trimmed = message.replace(/\s+/g, " ").slice(0, 180);
  return trimmed ? `${name} returned ${status}: ${trimmed}` : `${name} returned ${status}.`;
}
