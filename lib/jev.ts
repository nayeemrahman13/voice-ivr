import { HttpError } from "./errors";
import { CONFIDENCE, type Menu, replyFor, UNCLEAR } from "./menu";

export type Turn = {
  role: "user" | "assistant";
  text: string;
};

export type Choice = ReturnType<typeof replyFor> & {
  probabilities: Record<string, number>;
};

export function buildJevRequest(menu: Menu, turn: string, history: Turn[]) {
  const criteria: Record<string, string> = {};
  for (const option of menu.options) {
    criteria[option.id] = [option.title, option.hints].filter(Boolean).join(". ");
  }
  criteria[UNCLEAR] = "None of the options. The caller is unsure, silent, or talking about something else.";

  return {
    model: "jev-latest",
    state: {
      history: history.map((item) => ({ role: item.role, text: item.text })),
      turn,
    },
    questions: {
      option: {
        type: "choice",
        instructions:
          'Which option is the caller in `turn` choosing? Use `history` only to resolve references such as "the first one" or "that one".',
        criteria,
      },
    },
  };
}

export function parseChoice(payload: unknown, menu: Menu, threshold = CONFIDENCE): Choice {
  const answers = record(payload).answers;
  const option = record(record(answers).option);
  const choice = typeof option.choice === "string" ? option.choice : UNCLEAR;
  const confidence = typeof option.confidence === "number" ? option.confidence : 0;
  const probabilities = numberMap(option.probabilities);
  return { ...replyFor(menu, choice, confidence, threshold), probabilities };
}

export async function classifyTurn(args: {
  apiKey: string;
  menu: Menu;
  turn: string;
  history?: Turn[];
  fetchImpl?: typeof fetch;
  threshold?: number;
}): Promise<Choice> {
  const apiKey = args.apiKey.trim();
  if (!apiKey) throw new HttpError("Add TYPESAFE_API_KEY to .env.local and restart.", 400);
  const turn = args.turn.trim();
  if (!turn) throw new HttpError("There is no caller text to classify.", 400);

  const response = await (args.fetchImpl ?? fetch)("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildJevRequest(args.menu, turn, args.history ?? [])),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new HttpError(providerMessage("Jev", response.status, payload), 502);
  }
  return parseChoice(payload, args.menu, args.threshold);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function numberMap(value: unknown): Record<string, number> {
  const source = record(value);
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === "number") result[key] = entry;
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
