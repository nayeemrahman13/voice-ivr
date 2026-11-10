import { HttpError } from "./errors";

export const CONFIDENCE = 0.55;
export const UNCLEAR = "unclear";

export type MenuOption = {
  id: string;
  title: string;
  hints: string;
  reply: string;
  menu?: Menu;
};

export type Menu = {
  name: string;
  script: string;
  options: MenuOption[];
  start?: string[];
};

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "option";
}

export function withUniqueIds(options: MenuOption[]): MenuOption[] {
  const seen = new Set<string>([UNCLEAR]);
  return options.map((option) => {
    let id = slugify(option.id || option.title);
    if (id === UNCLEAR) id = "unclear_option";
    const base = id;
    let n = 2;
    while (seen.has(id)) {
      id = `${base}_${n}`;
      n += 1;
    }
    seen.add(id);
    return { ...option, id };
  });
}

export function spokenList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

export function presentMenu(name: string, options: { title: string }[]): string {
  const intro = name.trim() ? `Thanks for calling ${name.trim()}.` : "Thanks for calling.";
  const titles = options.map((option) => option.title.trim()).filter(Boolean);
  if (titles.length === 0) return intro;
  return `${intro} You can say ${spokenList(titles)}.`;
}

export function presentDeeper(name: string, options: { title: string }[]): string {
  const place = name.trim() || "This menu";
  const titles = options.map((option) => option.title.trim()).filter(Boolean);
  if (titles.length === 0) return `${place}.`;
  return `${place}. You can say ${spokenList(titles)}.`;
}

export function reprompt(options: { title: string }[]): string {
  const titles = options.map((option) => option.title.trim()).filter(Boolean);
  if (titles.length === 0) return "Sorry, I didn't catch that.";
  return `Sorry, I didn't catch that. You can say ${spokenList(titles)}.`;
}

export function systemMessage(menu: Menu): string {
  return [
    "The voice speaks only the stored line for the chosen option, and the stored reprompt when the choice is unclear. An option can open a nested menu. Say that menu's script and then choose only among its options.",
    "",
    "<<ivr>>",
    JSON.stringify(menu),
    "<</ivr>>",
  ].join("\n");
}

export function readMenu(text: string): Menu | null {
  const match = text.match(/<<ivr>>\s*([\s\S]*?)\s*<<\/ivr>>/);
  if (!match) return null;
  try {
    return parseMenu(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

export function parseMenu(value: unknown, nested = false): Menu {
  if (!value || typeof value !== "object") {
    throw new HttpError("Menu is missing.", 400);
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.options) || record.options.length === 0) {
    throw new HttpError(nested ? "Add at least one option to the nested menu." : "Add at least one option.", 400);
  }
  const options = record.options.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new HttpError(`Option ${index + 1} is incomplete.`, 400);
    }
    const option = entry as Record<string, unknown>;
    const title = stringField(option.title);
    if (!title) throw new HttpError(`Option ${index + 1} needs a title.`, 400);
    const deeper = option.menu && typeof option.menu === "object" ? parseMenu(option.menu, true) : undefined;
    return {
      id: stringField(option.id) || slugify(title),
      title,
      hints: stringField(option.hints),
      reply: stringField(option.reply),
      ...(deeper ? { menu: deeper } : {}),
    };
  });
  const unique = withUniqueIds(options);
  const name = stringField(record.name);
  const start = Array.isArray(record.start)
    ? record.start.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
  return {
    name,
    script: stringField(record.script) || (nested ? presentDeeper(name, unique) : presentMenu(name, unique)),
    options: unique,
    ...(start.length ? { start } : {}),
  };
}

export function menuAt(menu: Menu, path: string[] = []): Menu {
  let node = menu;
  for (const id of path) {
    const next = node.options.find((option) => option.id === id)?.menu;
    if (!next) break;
    node = next;
  }
  return node;
}

export function followPlace(menu: Menu, assistantLines: string[]): { menu: Menu; label: string } {
  const titles: string[] = [];
  let node = menu;
  for (const id of menu.start ?? []) {
    const option = node.options.find((item) => item.id === id && item.menu);
    if (!option?.menu) break;
    titles.push(option.title);
    node = option.menu;
  }
  for (const line of assistantLines) {
    if (line === node.script) continue;
    const option = node.options.find((item) => item.menu && item.menu.script === line);
    if (!option?.menu) continue;
    titles.push(option.title);
    node = option.menu;
  }
  return { menu: node, label: [menu.name, ...titles].filter(Boolean).join(" / ") || "Main menu" };
}

export function spokenLine(option: MenuOption): string {
  if (option.menu) return option.menu.script.trim() || presentDeeper(option.menu.name || option.title, option.menu.options);
  return option.reply.trim() || `Okay. ${option.title}.`;
}

export function replyFor(
  menu: Menu,
  optionId: string,
  confidence: number,
  threshold = CONFIDENCE,
): { optionId: string; title: string; reply: string; confidence: number; unclear: boolean } {
  const option = menu.options.find((item) => item.id === optionId);
  if (!option || optionId === UNCLEAR || confidence < threshold) {
    return {
      optionId: UNCLEAR,
      title: "Unclear",
      reply: reprompt(menu.options),
      confidence,
      unclear: true,
    };
  }
  return {
    optionId: option.id,
    title: option.title,
    reply: spokenLine(option),
    confidence,
    unclear: false,
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
