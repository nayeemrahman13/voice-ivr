import { classifyTurn, type Turn } from "./jev";
import { followPlace, type Menu, parseMenu, readMenu, reprompt } from "./menu";

type IncomingMessage = {
  role?: string;
  content?: unknown;
};

export type SpokenTurn = {
  content: string;
  stage: "jev";
  place: string;
};

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join(" ")
    .trim();
}

export function menuFromRequest(body: unknown): Menu | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { messages?: IncomingMessage[]; metadata?: { ivr?: unknown } };
  const messages = Array.isArray(record.messages) ? record.messages : [];
  for (const message of messages) {
    if (message.role !== "system") continue;
    const menu = readMenu(contentToText(message.content));
    if (menu) return menu;
  }
  if (record.metadata && typeof record.metadata === "object" && record.metadata.ivr) {
    try {
      return parseMenu(record.metadata.ivr);
    } catch {
      return null;
    }
  }
  return null;
}

export function conversationFrom(body: unknown): Turn[] {
  const messages = body && typeof body === "object" && Array.isArray((body as { messages?: unknown }).messages)
    ? (body as { messages: IncomingMessage[] }).messages
    : [];
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as Turn["role"],
      text: contentToText(message.content),
    }))
    .filter((message) => message.text);
}

export async function answerTurn(args: {
  body: unknown;
  jevKey: string;
  fetchImpl?: typeof fetch;
}): Promise<SpokenTurn> {
  const menu = menuFromRequest(args.body);
  if (!menu) return { content: "This assistant is missing its menu.", stage: "jev", place: "" };

  const conversational = conversationFrom(args.body);
  const assistantLines = conversational.filter((message) => message.role === "assistant").map((message) => message.text);
  const located = followPlace(menu, assistantLines);
  const latestUserIndex = conversational.findLastIndex((message) => message.role === "user");
  if (latestUserIndex === -1) {
    const assistantSpoke = assistantLines.length > 0;
    return {
      content: assistantSpoke ? "" : located.menu.script || reprompt(located.menu.options),
      stage: "jev",
      place: located.label,
    };
  }

  const choice = await classifyTurn({
    apiKey: args.jevKey,
    menu: located.menu,
    turn: conversational[latestUserIndex].text,
    history: conversational.slice(0, latestUserIndex),
    fetchImpl: args.fetchImpl,
  });
  const after = followPlace(menu, [...assistantLines, choice.reply]);
  return { content: choice.reply, stage: "jev", place: after.label };
}
