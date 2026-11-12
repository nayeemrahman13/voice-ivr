import { HttpError } from "./errors";

export const CONFIDENCE = 0.55;
export const NOUL_YES_THRESHOLD = 0.7;
export const NOUL_NO_THRESHOLD = 0.3;

export const UNCLEAR = "unclear";
export const GLOBAL_BACK = "global_back";
export const GLOBAL_REPEAT = "global_repeat";
export const GLOBAL_OPERATOR = "global_operator";

export const RESERVED_OPTION_IDS = new Set<string>([
  UNCLEAR,
  GLOBAL_BACK,
  GLOBAL_REPEAT,
  GLOBAL_OPERATOR,
]);

export const VALID_DTMF = new Set<string>(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#"]);
const ID_PATTERN = /^[a-z0-9_]+$/;
const QUESTION_KEY_PATTERN = /^[a-zA-Z0-9_]+$/;

export const DEFAULT_BACK_HINTS = "Go back, previous menu, return to the previous options";
export const DEFAULT_REPEAT_HINTS = "Repeat the options, say that again, what were the choices";
export const DEFAULT_OPERATOR_HINTS = "Operator, representative, human agent, speak to a person";

export type DtmfKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "*" | "#";
export type TransferMode = "twilio_dial" | "daily_sip_refer" | "custom";

export type FallbackAction =
  | { type: "end_call"; reply?: string }
  | { type: "goto"; target: string; reply?: string }
  | { type: "transfer"; target: string; mode?: TransferMode; reply?: string; metadata?: Record<string, string> }
  | { type: "handoff_llm"; systemPrompt?: string; reply?: string };

export type WebhookNextAction =
  | { type: "end_call" }
  | { type: "goto"; target: string }
  | { type: "handoff_llm"; systemPrompt?: string };

export type MenuAction =
  | { type: "goto"; target: string }
  | { type: "reply_only" }
  | { type: "end_call" }
  | { type: "transfer"; target: string; mode?: TransferMode; metadata?: Record<string, string> }
  | {
      type: "webhook";
      url: string;
      method?: "POST" | "PUT";
      headers?: Record<string, string>;
      timeoutMs?: number;
      failureReply?: string;
      onFailure?: FallbackAction;
      next: WebhookNextAction;
    }
  | { type: "handoff_llm"; systemPrompt?: string };

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
  yesThreshold?: number;
  noThreshold?: number;
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
  confidenceThreshold?: number;
};

export type SecondaryQuestion = NoulQuestion | ChoiceQuestion;

export type GlobalToggleConfig = boolean | { hints?: string; dtmf?: DtmfKey };

export type GlobalOperatorConfig =
  | false
  | {
      hints?: string;
      dtmf?: DtmfKey;
      reply?: string;
      action: FallbackAction;
    };

export type MenuGlobals = {
  back: GlobalToggleConfig;
  repeat: GlobalToggleConfig;
  operator?: GlobalOperatorConfig;
};

export type MenuNodeOption = {
  id: string;
  title: string;
  hints: string;
  dtmf?: DtmfKey;
  reply: string;
  action: MenuAction;
};

export type MenuNode = {
  id: string;
  name: string;
  script: string;
  reprompt?: string;
  confidenceThreshold?: number;
  questions?: Record<string, SecondaryQuestion>;
  options: MenuNodeOption[];
};

export type MenuEvalCase = {
  id?: string;
  split: "tune" | "holdout";
  node: string;
  stack?: string[];
  history?: { role: "user" | "assistant"; text: string }[];
  say: string;
  expect: string;
  expectExtracted?: Record<string, boolean | string | null>;
};

export type MenuGraph = {
  version: 2;
  id: string;
  name: string;
  entry: string;
  initialStack?: string[];
  confidenceThreshold: number;
  maxUnclearTurns: number;
  fallbackAction?: FallbackAction;
  globals: MenuGlobals;
  nodes: Record<string, MenuNode>;
  evals?: MenuEvalCase[];
};

// Legacy v1 nested-tree types retained solely for migration support
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

export type ValidationIssue = {
  code: string;
  path: string;
  message: string;
};

export type ValidationReport = {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

export type SecondaryResult = {
  value: boolean | string | null;
  raw: number;
};

export type TurnStepResult = {
  outcomeChoice: string;
  matchedTitle: string;
  unclear: boolean;
  spokenReply: string;
  nextNodeId: string;
  nextStack: string[];
  nextUnclearStreak: number;
  extracted: Record<string, boolean | string>;
  terminalAction: MenuAction | FallbackAction | null;
};

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "option";
}

export function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function setOwn<V>(obj: Record<string, V>, key: string, value: V): Record<string, V> {
  Object.defineProperty(obj, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return obj;
}

export function cloneRecord<V>(source: Record<string, V> | undefined): Record<string, V> {
  const out: Record<string, V> = {};
  if (!source) return out;
  for (const [k, v] of Object.entries(source)) {
    setOwn(out, k, v);
  }
  return out;
}

export function withUniqueIds<T extends { id: string; title: string }>(options: T[]): T[] {
  const seen = new Set<string>(RESERVED_OPTION_IDS);
  return options.map((option) => {
    let id = slugify(option.id || option.title);
    if (RESERVED_OPTION_IDS.has(id)) id = `${id}_option`;
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

export function parseMenuGraph(value: unknown): MenuGraph {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError("Menu is missing or invalid.", 400);
  }
  const rec = value as Record<string, unknown>;
  if (hasOwn(rec, "version") && rec.version !== undefined) {
    if (rec.version !== 2) {
      throw new HttpError(`Unsupported menu version: ${String(rec.version)}. Expected version 2.`, 400);
    }
    return parseCanonicalV2(rec);
  }
  if (Array.isArray(rec.options)) {
    return migrateV1ToV2(rec);
  }
  throw new HttpError("Menu must be a canonical v2 graph (version: 2) or a legacy v1 menu.", 400);
}

function parseCanonicalV2(rec: Record<string, unknown>): MenuGraph {
  const id = requireId(rec.id, "id");
  const name = stringField(rec.name);
  const entry = requireId(rec.entry, "entry");

  const confidenceThreshold = parseProbability(rec.confidenceThreshold, CONFIDENCE, "confidenceThreshold", true);
  const maxUnclearTurns = parsePositiveInt(rec.maxUnclearTurns, 2, "maxUnclearTurns");

  if (!rec.nodes || typeof rec.nodes !== "object" || Array.isArray(rec.nodes)) {
    throw new HttpError("Menu v2 requires a `nodes` object.", 400);
  }
  const rawNodes = rec.nodes as Record<string, unknown>;
  const nodeKeys = Object.keys(rawNodes);
  if (nodeKeys.length === 0) {
    throw new HttpError("Menu v2 requires at least one node in `nodes`.", 400);
  }

  const globals = parseGlobals(rec.globals);
  const fallbackAction = rec.fallbackAction !== undefined ? parseFallbackAction(rec.fallbackAction, "fallbackAction") : undefined;

  const nodes: Record<string, MenuNode> = {};
  for (const key of nodeKeys) {
    if (!ID_PATTERN.test(key)) {
      throw new HttpError(`Invalid node key '${key}'. Use lowercase letters, numbers, and underscores.`, 400);
    }
    const nodeVal = rawNodes[key];
    if (!nodeVal || typeof nodeVal !== "object" || Array.isArray(nodeVal)) {
      throw new HttpError(`Node '${key}' must be an object.`, 400);
    }
    const nRec = nodeVal as Record<string, unknown>;
    const nodeId = requireId(nRec.id, `nodes.${key}.id`);
    if (nodeId !== key) {
      throw new HttpError(`Node '${key}' has mismatched id '${nodeId}'.`, 400);
    }
    const nodeName = stringField(nRec.name);
    const nodeThreshold =
      nRec.confidenceThreshold !== undefined
        ? parseProbability(nRec.confidenceThreshold, confidenceThreshold, `nodes.${key}.confidenceThreshold`, true)
        : undefined;

    if (!Array.isArray(nRec.options) || nRec.options.length === 0) {
      throw new HttpError(`Node '${key}' must define at least one option.`, 400);
    }

    const seenOptionIds = new Set<string>();
    const seenDtmf = new Set<string>();
    for (const gKey of globalDtmfKeys(globals)) {
      seenDtmf.add(gKey);
    }

    const options: MenuNodeOption[] = nRec.options.map((optVal, idx) => {
      const path = `nodes.${key}.options[${idx}]`;
      if (!optVal || typeof optVal !== "object" || Array.isArray(optVal)) {
        throw new HttpError(`${path} must be an object.`, 400);
      }
      const oRec = optVal as Record<string, unknown>;
      const optId = requireId(oRec.id, `${path}.id`);
      if (RESERVED_OPTION_IDS.has(optId)) {
        throw new HttpError(`${path}.id '${optId}' is reserved.`, 400);
      }
      if (seenOptionIds.has(optId)) {
        throw new HttpError(`Duplicate option id '${optId}' in node '${key}'.`, 400);
      }
      seenOptionIds.add(optId);

      const title = stringField(oRec.title);
      if (!title) {
        throw new HttpError(`${path}.title is required.`, 400);
      }

      let dtmf: DtmfKey | undefined;
      if (oRec.dtmf !== undefined && oRec.dtmf !== "") {
        dtmf = parseDtmf(oRec.dtmf, `${path}.dtmf`);
        if (seenDtmf.has(dtmf)) {
          throw new HttpError(`Duplicate DTMF key '${dtmf}' in node '${key}' (or colliding with globals).`, 400);
        }
        seenDtmf.add(dtmf);
      }

      const action = parseMenuAction(oRec.action, `${path}.action`);
      return {
        id: optId,
        title,
        hints: stringField(oRec.hints),
        ...(dtmf ? { dtmf } : {}),
        reply: stringField(oRec.reply),
        action,
      };
    });

    const questions = nRec.questions !== undefined ? parseQuestions(nRec.questions, `nodes.${key}.questions`) : undefined;
    const rawScript = stringField(nRec.script);
    const script = rawScript || (key === entry ? presentMenu(nodeName || name, options) : presentDeeper(nodeName, options));
    const repromptLine = stringField(nRec.reprompt);

    setOwn(nodes, key, {
      id: key,
      name: nodeName,
      script,
      ...(repromptLine ? { reprompt: repromptLine } : {}),
      ...(nodeThreshold !== undefined ? { confidenceThreshold: nodeThreshold } : {}),
      ...(questions && Object.keys(questions).length > 0 ? { questions } : {}),
      options,
    });
  }

  if (!hasOwn(nodes, entry)) {
    throw new HttpError(`Entry node '${entry}' does not exist in nodes.`, 400);
  }

  let initialStack: string[] | undefined;
  if (rec.initialStack !== undefined) {
    if (!Array.isArray(rec.initialStack)) {
      throw new HttpError("`initialStack` must be an array of node IDs.", 400);
    }
    initialStack = rec.initialStack.map((item, idx) => {
      const stackId = requireId(item, `initialStack[${idx}]`);
      if (!hasOwn(nodes, stackId)) {
        throw new HttpError(`initialStack[${idx}] references unknown node '${stackId}'.`, 400);
      }
      return stackId;
    });
  }

  // Verify all target node references across options, webhooks, fallback, and globals
  assertTargetExists(fallbackAction, nodes, "fallbackAction");
  if (globals.operator && typeof globals.operator === "object") {
    assertTargetExists(globals.operator.action, nodes, "globals.operator.action");
  }
  for (const node of Object.values(nodes)) {
    for (const opt of node.options) {
      assertActionTargetsExist(opt.action, nodes, `nodes.${node.id}.options.${opt.id}.action`);
    }
  }

  let evals: MenuEvalCase[] | undefined;
  if (rec.evals !== undefined) {
    if (!Array.isArray(rec.evals)) {
      throw new HttpError("`evals` must be an array.", 400);
    }
    evals = rec.evals.map((item, idx) => parseEvalCase(item, idx, entry, initialStack, nodes, globals));
  }

  return {
    version: 2,
    id,
    name,
    entry,
    ...(initialStack && initialStack.length > 0 ? { initialStack } : {}),
    confidenceThreshold,
    maxUnclearTurns,
    ...(fallbackAction ? { fallbackAction } : {}),
    globals,
    nodes,
    ...(evals ? { evals } : {}),
  };
}

export function migrateV1ToV2(rec: Record<string, unknown>): MenuGraph {
  const rootName = stringField(rec.name);
  const graphId = slugify(rootName || "ivr");
  const nodes: Record<string, MenuNode> = {};
  const usedNodeIds = new Set<string>(["main"]);

  function allocNodeId(hint: string): string {
    let base = slugify(hint || "menu");
    if (RESERVED_OPTION_IDS.has(base)) base = `${base}_menu`;
    let candidate = base;
    let n = 2;
    while (usedNodeIds.has(candidate)) {
      candidate = `${base}_${n}`;
      n += 1;
    }
    usedNodeIds.add(candidate);
    return candidate;
  }

  // Maps nodeId -> (rawOptionSlugOrId -> repairedOptionId & childNodeId)
  const childByOriginalRef = new Map<string, { repairedId: string; childNodeId: string }[]>();

  function visitMenu(raw: Record<string, unknown>, nodeId: string, isRoot: boolean): void {
    if (!Array.isArray(raw.options) || raw.options.length === 0) {
      throw new HttpError(isRoot ? "Add at least one option." : "Add at least one option to the nested menu.", 400);
    }

    const rawEntries = raw.options.map((entry, idx) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new HttpError(`Option ${idx + 1} is incomplete.`, 400);
      }
      const o = entry as Record<string, unknown>;
      const title = stringField(o.title);
      if (!title) throw new HttpError(`Option ${idx + 1} needs a title.`, 400);
      const rawId = stringField(o.id) || slugify(title);
      const nested = o.menu && typeof o.menu === "object" && !Array.isArray(o.menu) ? (o.menu as Record<string, unknown>) : undefined;
      return {
        rawId,
        id: rawId,
        title,
        hints: stringField(o.hints),
        reply: stringField(o.reply),
        nested,
      };
    });

    const uniqueEntries = withUniqueIds(rawEntries);
    const transitions: { rawId: string; repairedId: string; childNodeId: string }[] = [];

    const options: MenuNodeOption[] = uniqueEntries.map((item) => {
      if (item.nested) {
        const childId = allocNodeId(item.id || item.title);
        visitMenu(item.nested, childId, false);
        transitions.push({ rawId: item.rawId, repairedId: item.id, childNodeId: childId });
        return {
          id: item.id,
          title: item.title,
          hints: item.hints,
          reply: "",
          action: { type: "goto", target: childId },
        };
      }
      return {
        id: item.id,
        title: item.title,
        hints: item.hints,
        reply: item.reply,
        action: { type: "reply_only" },
      };
    });

    childByOriginalRef.set(
      nodeId,
      transitions.map((t) => ({ repairedId: t.repairedId, childNodeId: t.childNodeId })),
    );
    // Also index rawIds in case v1 `start` referenced pre-dedup or slug IDs
    const nodeName = stringField(raw.name);
    const rawScript = stringField(raw.script);
    setOwn(nodes, nodeId, {
      id: nodeId,
      name: nodeName,
      script: rawScript || (isRoot ? presentMenu(nodeName, options) : presentDeeper(nodeName, options)),
      options,
    });

    // Attach rawId lookup metadata for start path resolution
    (childByOriginalRef.get(nodeId) as { repairedId: string; rawId?: string; childNodeId: string }[]).forEach((entry, i) => {
      entry.rawId = transitions[i].rawId;
    });
  }

  visitMenu(rec, "main", true);

  let entry = "main";
  const initialStack: string[] = [];
  if (Array.isArray(rec.start)) {
    for (const rawStep of rec.start) {
      if (typeof rawStep !== "string" || !rawStep.trim()) continue;
      const step = rawStep.trim();
      const candidates = (childByOriginalRef.get(entry) ?? []) as {
        repairedId: string;
        rawId?: string;
        childNodeId: string;
      }[];
      const match = candidates.find(
        (c) => c.repairedId === step || c.rawId === step || slugify(step) === c.repairedId,
      );
      if (!match) break;
      initialStack.push(entry);
      entry = match.childNodeId;
    }
  }

  return {
    version: 2,
    id: graphId,
    name: rootName,
    entry,
    ...(initialStack.length > 0 ? { initialStack } : {}),
    confidenceThreshold: CONFIDENCE,
    maxUnclearTurns: 2,
    globals: { back: true, repeat: true },
    nodes,
  };
}

export function validateMenuGraph(graph: MenuGraph): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 1. Reachability from entry + initialStack
  const reachable = new Set<string>();
  const queue: string[] = [graph.entry, ...(graph.initialStack ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current) || !hasOwn(graph.nodes, current)) continue;
    reachable.add(current);
    for (const target of outgoingTargets(graph, current)) {
      if (!reachable.has(target)) queue.push(target);
    }
  }

  for (const nodeId of Object.keys(graph.nodes)) {
    if (!reachable.has(nodeId)) {
      errors.push({
        code: "orphan_node",
        path: `nodes.${nodeId}`,
        message: `Node '${nodeId}' is unreachable from entry '${graph.entry}'.`,
      });
    }
  }

  // 2. Every reachable node must have a path to at least one terminal exit action
  const canExit = new Set<string>();
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (nodeHasDirectExit(graph, node)) {
      canExit.add(nodeId);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const nodeId of Object.keys(graph.nodes)) {
      if (canExit.has(nodeId)) continue;
      for (const target of outgoingTargets(graph, nodeId)) {
        if (canExit.has(target)) {
          canExit.add(nodeId);
          changed = true;
          break;
        }
      }
    }
  }

  for (const nodeId of reachable) {
    if (!canExit.has(nodeId)) {
      errors.push({
        code: "trapped_cycle",
        path: `nodes.${nodeId}`,
        message: `Node '${nodeId}' is part of a cycle with no reachable terminal action (end_call, transfer, handoff_llm, or reply_only).`,
      });
    }
  }

  // 3. Voice UX warnings & eval coverage checks
  const evalsByNodeOption = new Set<string>();
  let hasUnclearEval = false;
  for (const ev of graph.evals ?? []) {
    if (ev.expect === UNCLEAR) hasUnclearEval = true;
    evalsByNodeOption.add(`${ev.node}:${ev.expect}`);
  }

  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (node.options.length < 2) {
      warnings.push({
        code: "single_option_node",
        path: `nodes.${nodeId}.options`,
        message: `Node '${nodeId}' only has 1 option; menus typically present 2–4 choices.`,
      });
    }
    if (node.options.length > 4) {
      warnings.push({
        code: "too_many_options",
        path: `nodes.${nodeId}.options`,
        message: `Node '${nodeId}' has ${node.options.length} options; <=4 options per spoken prompt reduces caller cognitive load.`,
      });
    }
    const wordCount = node.script.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount > 45) {
      warnings.push({
        code: "long_script",
        path: `nodes.${nodeId}.script`,
        message: `Node '${nodeId}' script is ${wordCount} words (>45 words takes >18s to speak).`,
      });
    }
    const lowerScript = node.script.toLowerCase();
    for (const opt of node.options) {
      if (!lowerScript.includes(opt.title.toLowerCase())) {
        warnings.push({
          code: "unmentioned_option",
          path: `nodes.${nodeId}.options.${opt.id}`,
          message: `Spoken script in '${nodeId}' does not mention option '${opt.title}'.`,
        });
      }
      if (!opt.hints.trim()) {
        warnings.push({
          code: "empty_hints",
          path: `nodes.${nodeId}.options.${opt.id}.hints`,
          message: `Option '${opt.id}' in '${nodeId}' has empty hints; contrastive hints improve Jev separation.`,
        });
      }
      if ((graph.evals?.length ?? 0) > 0 && !evalsByNodeOption.has(`${nodeId}:${opt.id}`)) {
        warnings.push({
          code: "missing_option_eval",
          path: `nodes.${nodeId}.options.${opt.id}`,
          message: `No eval case covers option '${opt.id}' in node '${nodeId}'.`,
        });
      }
    }
  }

  if (!graph.evals || graph.evals.length === 0) {
    warnings.push({
      code: "no_evals",
      path: "evals",
      message: "Menu defines no `evals[]` test utterances.",
    });
  } else if (!hasUnclearEval) {
    warnings.push({
      code: "missing_unclear_eval",
      path: "evals",
      message: "Eval suite has no negative out-of-scope (`expect: \"unclear\"`) test case.",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function activeGlobalsForNode(
  graph: MenuGraph,
  stackDepth: number,
): Record<string, { title: string; hints: string; dtmf?: DtmfKey }> {
  const active: Record<string, { title: string; hints: string; dtmf?: DtmfKey }> = {};
  if (stackDepth > 0 && graph.globals.back !== false) {
    const cfg = typeof graph.globals.back === "object" ? graph.globals.back : {};
    active[GLOBAL_BACK] = {
      title: "Back",
      hints: cfg.hints?.trim() || DEFAULT_BACK_HINTS,
      ...(cfg.dtmf ? { dtmf: cfg.dtmf } : {}),
    };
  }
  if (graph.globals.repeat !== false) {
    const cfg = typeof graph.globals.repeat === "object" ? graph.globals.repeat : {};
    active[GLOBAL_REPEAT] = {
      title: "Repeat",
      hints: cfg.hints?.trim() || DEFAULT_REPEAT_HINTS,
      ...(cfg.dtmf ? { dtmf: cfg.dtmf } : {}),
    };
  }
  if (graph.globals.operator && typeof graph.globals.operator === "object") {
    active[GLOBAL_OPERATOR] = {
      title: "Operator",
      hints: graph.globals.operator.hints?.trim() || DEFAULT_OPERATOR_HINTS,
      ...(graph.globals.operator.dtmf ? { dtmf: graph.globals.operator.dtmf } : {}),
    };
  }
  return active;
}

export function stepMenuTurn(args: {
  graph: MenuGraph;
  nodeId: string;
  stack?: string[];
  unclearStreak?: number;
  extracted?: Record<string, boolean | string>;
  choice: string;
  confidence: number;
  secondaryAnswers?: Record<string, SecondaryResult>;
}): TurnStepResult {
  const { graph } = args;
  const node = hasOwn(graph.nodes, args.nodeId) ? graph.nodes[args.nodeId] : undefined;
  if (!node) {
    throw new HttpError(`Unknown menu node '${args.nodeId}'.`, 400);
  }
  const stack = [...(args.stack ?? [])];
  const unclearStreak = args.unclearStreak ?? 0;
  const extracted: Record<string, boolean | string> = cloneRecord(args.extracted);

  if (args.secondaryAnswers) {
    for (const [key, res] of Object.entries(args.secondaryAnswers)) {
      if (res.value !== null && res.value !== undefined) {
        setOwn(extracted, key, res.value);
      }
    }
  }

  const threshold = node.confidenceThreshold ?? graph.confidenceThreshold;
  const globals = activeGlobalsForNode(graph, stack.length);
  const rawChoice = args.choice;
  const isConfident = rawChoice !== UNCLEAR && args.confidence >= threshold;

  if (isConfident && rawChoice === GLOBAL_REPEAT && hasOwn(globals, GLOBAL_REPEAT)) {
    return {
      outcomeChoice: GLOBAL_REPEAT,
      matchedTitle: "Repeat",
      unclear: false,
      spokenReply: node.script,
      nextNodeId: node.id,
      nextStack: stack,
      nextUnclearStreak: 0,
      extracted,
      terminalAction: null,
    };
  }

  if (isConfident && rawChoice === GLOBAL_BACK && hasOwn(globals, GLOBAL_BACK) && stack.length > 0) {
    const parentId = stack[stack.length - 1];
    const nextStack = stack.slice(0, -1);
    const parentNode = hasOwn(graph.nodes, parentId) ? graph.nodes[parentId] : node;
    return {
      outcomeChoice: GLOBAL_BACK,
      matchedTitle: "Back",
      unclear: false,
      spokenReply: parentNode.script,
      nextNodeId: parentNode.id,
      nextStack,
      nextUnclearStreak: 0,
      extracted,
      terminalAction: null,
    };
  }

  if (
    isConfident &&
    rawChoice === GLOBAL_OPERATOR &&
    hasOwn(globals, GLOBAL_OPERATOR) &&
    graph.globals.operator &&
    typeof graph.globals.operator === "object"
  ) {
    const op = graph.globals.operator;
    return applyFallbackAction({
      graph,
      node,
      stack,
      extracted,
      outcomeChoice: GLOBAL_OPERATOR,
      matchedTitle: "Operator",
      unclear: false,
      fallback: op.action,
      overrideReply: op.reply,
    });
  }

  const option = isConfident ? node.options.find((item) => item.id === rawChoice) : undefined;
  if (!option) {
    const nextStreak = unclearStreak + 1;
    if (nextStreak >= graph.maxUnclearTurns && graph.fallbackAction) {
      return applyFallbackAction({
        graph,
        node,
        stack,
        extracted,
        outcomeChoice: UNCLEAR,
        matchedTitle: "Unclear (Fallback)",
        unclear: true,
        fallback: graph.fallbackAction,
      });
    }
    return {
      outcomeChoice: UNCLEAR,
      matchedTitle: "Unclear",
      unclear: true,
      spokenReply: node.reprompt?.trim() || reprompt(node.options),
      nextNodeId: node.id,
      nextStack: stack,
      nextUnclearStreak: nextStreak,
      extracted,
      terminalAction: null,
    };
  }

  if (option.action.type === "goto") {
    const targetNode = graph.nodes[option.action.target];
    const nextStack = pushNodeStack(stack, node.id, targetNode.id);
    const spoken = [option.reply.trim(), targetNode.script.trim()].filter(Boolean).join(" ");
    return {
      outcomeChoice: option.id,
      matchedTitle: option.title,
      unclear: false,
      spokenReply: spoken,
      nextNodeId: targetNode.id,
      nextStack,
      nextUnclearStreak: 0,
      extracted,
      terminalAction: null,
    };
  }

  if (option.action.type === "handoff_llm") {
    return {
      outcomeChoice: option.id,
      matchedTitle: option.title,
      unclear: false,
      spokenReply: option.reply.trim(),
      nextNodeId: node.id,
      nextStack: stack,
      nextUnclearStreak: 0,
      extracted,
      terminalAction: option.action,
    };
  }

  const spoken = option.reply.trim() || `Okay. ${option.title}.`;
  let nextNodeId = node.id;
  let nextStack = stack;
  if (option.action.type === "webhook" && option.action.next.type === "goto") {
    const targetNode = graph.nodes[option.action.next.target];
    nextStack = pushNodeStack(stack, node.id, targetNode.id);
    nextNodeId = targetNode.id;
  }

  return {
    outcomeChoice: option.id,
    matchedTitle: option.title,
    unclear: false,
    spokenReply: spoken,
    nextNodeId,
    nextStack,
    nextUnclearStreak: 0,
    extracted,
    terminalAction: option.action,
  };
}

function applyFallbackAction(args: {
  graph: MenuGraph;
  node: MenuNode;
  stack: string[];
  extracted: Record<string, boolean | string>;
  outcomeChoice: string;
  matchedTitle: string;
  unclear: boolean;
  fallback: FallbackAction;
  overrideReply?: string;
}): TurnStepResult {
  const { graph, node, stack, extracted, fallback } = args;
  const customReply = (args.overrideReply ?? fallback.reply ?? "").trim();
  if (fallback.type === "goto") {
    const target = graph.nodes[fallback.target];
    const nextStack = pushNodeStack(stack, node.id, target.id);
    return {
      outcomeChoice: args.outcomeChoice,
      matchedTitle: args.matchedTitle,
      unclear: args.unclear,
      spokenReply: [customReply, target.script.trim()].filter(Boolean).join(" "),
      nextNodeId: target.id,
      nextStack,
      nextUnclearStreak: 0,
      extracted,
      terminalAction: null,
    };
  }
  return {
    outcomeChoice: args.outcomeChoice,
    matchedTitle: args.matchedTitle,
    unclear: args.unclear,
    spokenReply: customReply || (fallback.type === "handoff_llm" ? "" : "Let me connect you."),
    nextNodeId: node.id,
    nextStack: stack,
    nextUnclearStreak: 0,
    extracted,
    terminalAction: fallback,
  };
}

function pushNodeStack(stack: string[], fromId: string, targetId: string): string[] {
  if (fromId === targetId) return [...stack];
  const ancestorIdx = stack.indexOf(targetId);
  if (ancestorIdx !== -1) {
    return stack.slice(0, ancestorIdx);
  }
  return [...stack, fromId];
}

function outgoingNodeTargets(node: MenuNode): string[] {
  const targets: string[] = [];
  for (const opt of node.options) {
    if (opt.action.type === "goto") targets.push(opt.action.target);
    if (opt.action.type === "webhook") {
      if (opt.action.next.type === "goto") targets.push(opt.action.next.target);
      if (opt.action.onFailure?.type === "goto") targets.push(opt.action.onFailure.target);
    }
  }
  return targets;
}

function outgoingTargets(graph: MenuGraph, nodeId: string): string[] {
  const node = hasOwn(graph.nodes, nodeId) ? graph.nodes[nodeId] : undefined;
  if (!node) return [];
  const targets = outgoingNodeTargets(node);
  if (graph.fallbackAction?.type === "goto") targets.push(graph.fallbackAction.target);
  if (graph.globals.operator && typeof graph.globals.operator === "object" && graph.globals.operator.action.type === "goto") {
    targets.push(graph.globals.operator.action.target);
  }
  return targets;
}

function nodeHasDirectExit(graph: MenuGraph, node: MenuNode): boolean {
  for (const opt of node.options) {
    const t = opt.action.type;
    if (t === "end_call" || t === "transfer" || t === "handoff_llm" || t === "reply_only") return true;
    if (t === "webhook" && opt.action.next.type !== "goto") return true;
  }
  if (graph.fallbackAction && graph.fallbackAction.type !== "goto") return true;
  if (
    graph.globals.operator &&
    typeof graph.globals.operator === "object" &&
    graph.globals.operator.action.type !== "goto"
  ) {
    return true;
  }
  return false;
}

function parseGlobals(value: unknown): MenuGlobals {
  if (value === undefined) return { back: true, repeat: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError("`globals` must be an object.", 400);
  }
  const rec = value as Record<string, unknown>;
  const back = parseGlobalToggle(rec.back, true, "globals.back");
  const repeat = parseGlobalToggle(rec.repeat, true, "globals.repeat");
  let operator: GlobalOperatorConfig | undefined;
  if (rec.operator !== undefined) {
    if (rec.operator === false) {
      operator = false;
    } else if (rec.operator && typeof rec.operator === "object" && !Array.isArray(rec.operator)) {
      const oRec = rec.operator as Record<string, unknown>;
      const dtmf = oRec.dtmf !== undefined && oRec.dtmf !== "" ? parseDtmf(oRec.dtmf, "globals.operator.dtmf") : undefined;
      operator = {
        ...(stringField(oRec.hints) ? { hints: stringField(oRec.hints) } : {}),
        ...(dtmf ? { dtmf } : {}),
        ...(stringField(oRec.reply) ? { reply: stringField(oRec.reply) } : {}),
        action: parseFallbackAction(oRec.action, "globals.operator.action"),
      };
    } else {
      throw new HttpError("`globals.operator` must be `false` or an object with `action`.", 400);
    }
  }

  // Ensure global DTMF shortcuts don't collide with each other
  const globalDtmf = new Set<string>();
  for (const [label, key] of [
    ["globals.back.dtmf", typeof back === "object" ? back.dtmf : undefined],
    ["globals.repeat.dtmf", typeof repeat === "object" ? repeat.dtmf : undefined],
    ["globals.operator.dtmf", operator && typeof operator === "object" ? operator.dtmf : undefined],
  ] as const) {
    if (!key) continue;
    if (globalDtmf.has(key)) {
      throw new HttpError(`Duplicate global DTMF key '${key}' at ${label}.`, 400);
    }
    globalDtmf.add(key);
  }

  return {
    back,
    repeat,
    ...(operator !== undefined ? { operator } : {}),
  };
}

function globalDtmfKeys(globals: MenuGlobals): string[] {
  const keys: string[] = [];
  if (typeof globals.back === "object" && globals.back.dtmf) keys.push(globals.back.dtmf);
  if (typeof globals.repeat === "object" && globals.repeat.dtmf) keys.push(globals.repeat.dtmf);
  if (globals.operator && typeof globals.operator === "object" && globals.operator.dtmf) {
    keys.push(globals.operator.dtmf);
  }
  return keys;
}

function parseGlobalToggle(value: unknown, defaultVal: boolean, path: string): GlobalToggleConfig {
  if (value === undefined) return defaultVal;
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    const dtmf = rec.dtmf !== undefined && rec.dtmf !== "" ? parseDtmf(rec.dtmf, `${path}.dtmf`) : undefined;
    return {
      ...(stringField(rec.hints) ? { hints: stringField(rec.hints) } : {}),
      ...(dtmf ? { dtmf } : {}),
    };
  }
  throw new HttpError(`${path} must be a boolean or config object.`, 400);
}

function parseQuestions(value: unknown, path: string): Record<string, SecondaryQuestion> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(`${path} must be an object.`, 400);
  }
  const rec = value as Record<string, unknown>;
  const out: Record<string, SecondaryQuestion> = {};
  for (const [key, raw] of Object.entries(rec)) {
    if (key === "option") {
      throw new HttpError(`${path}.option is reserved for primary option routing.`, 400);
    }
    if (!QUESTION_KEY_PATTERN.test(key)) {
      throw new HttpError(`${path}.${key} has an invalid question name.`, 400);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new HttpError(`${path}.${key} must be an object.`, 400);
    }
    const qRec = raw as Record<string, unknown>;
    const instructions = stringField(qRec.instructions);
    if (!instructions) {
      throw new HttpError(`${path}.${key}.instructions is required.`, 400);
    }
    if (qRec.type === "noul") {
      const yesThreshold = parseProbability(qRec.yesThreshold, NOUL_YES_THRESHOLD, `${path}.${key}.yesThreshold`, true);
      const noThreshold = parseProbability(qRec.noThreshold, NOUL_NO_THRESHOLD, `${path}.${key}.noThreshold`, false);
      if (noThreshold >= yesThreshold) {
        throw new HttpError(`${path}.${key} requires noThreshold < yesThreshold.`, 400);
      }
      let criteria: { true?: string; false?: string } | undefined;
      if (qRec.criteria !== undefined) {
        if (!qRec.criteria || typeof qRec.criteria !== "object" || Array.isArray(qRec.criteria)) {
          throw new HttpError(`${path}.${key}.criteria must be an object.`, 400);
        }
        const cRec = qRec.criteria as Record<string, unknown>;
        criteria = {
          ...(stringField(cRec.true) ? { true: stringField(cRec.true) } : {}),
          ...(stringField(cRec.false) ? { false: stringField(cRec.false) } : {}),
        };
      }
      setOwn(out, key, {
        type: "noul",
        instructions,
        ...(criteria && Object.keys(criteria).length > 0 ? { criteria } : {}),
        yesThreshold,
        noThreshold,
      });
    } else if (qRec.type === "choice") {
      if (!qRec.criteria || typeof qRec.criteria !== "object" || Array.isArray(qRec.criteria)) {
        throw new HttpError(`${path}.${key}.criteria must be an object with >=2 choices.`, 400);
      }
      const criteria: Record<string, string> = {};
      for (const [cKey, cVal] of Object.entries(qRec.criteria as Record<string, unknown>)) {
        if (typeof cVal !== "string") {
          throw new HttpError(`${path}.${key}.criteria.${cKey} must be a string.`, 400);
        }
        setOwn(criteria, cKey, cVal.trim());
      }
      if (Object.keys(criteria).length < 2) {
        throw new HttpError(`${path}.${key}.criteria requires at least 2 choices.`, 400);
      }
      const confidenceThreshold = parseProbability(
        qRec.confidenceThreshold,
        CONFIDENCE,
        `${path}.${key}.confidenceThreshold`,
        true,
      );
      setOwn(out, key, {
        type: "choice",
        instructions,
        criteria,
        confidenceThreshold,
      });
    } else {
      throw new HttpError(
        `${path}.${key}.type must be 'noul' or 'choice' (got '${String(qRec.type)}').`,
        400,
      );
    }
  }
  return out;
}

function parseMenuAction(value: unknown, path: string): MenuAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(`${path} must be an object.`, 400);
  }
  const rec = value as Record<string, unknown>;
  switch (rec.type) {
    case "goto":
      return { type: "goto", target: requireId(rec.target, `${path}.target`) };
    case "reply_only":
      return { type: "reply_only" };
    case "end_call":
      return { type: "end_call" };
    case "transfer": {
      const target = stringField(rec.target);
      if (!target) throw new HttpError(`${path}.target is required for transfer.`, 400);
      const mode = parseTransferMode(rec.mode, `${path}.mode`);
      const metadata = rec.metadata !== undefined ? parseStringMap(rec.metadata, `${path}.metadata`) : undefined;
      return {
        type: "transfer",
        target,
        ...(mode ? { mode } : {}),
        ...(metadata ? { metadata } : {}),
      };
    }
    case "webhook": {
      const url = stringField(rec.url);
      if (!url || (!url.startsWith("https://") && !url.startsWith("http://"))) {
        throw new HttpError(`${path}.url must be a valid HTTP(S) URL.`, 400);
      }
      const method = rec.method === undefined ? "POST" : rec.method;
      if (method !== "POST" && method !== "PUT") {
        throw new HttpError(`${path}.method must be 'POST' or 'PUT'.`, 400);
      }
      const timeoutMs = parsePositiveInt(rec.timeoutMs, 4000, `${path}.timeoutMs`);
      if (timeoutMs < 250 || timeoutMs > 30000) {
        throw new HttpError(`${path}.timeoutMs must be between 250 and 30000.`, 400);
      }
      const headers = rec.headers !== undefined ? parseStringMap(rec.headers, `${path}.headers`) : undefined;
      const onFailure =
        rec.onFailure !== undefined ? parseFallbackAction(rec.onFailure, `${path}.onFailure`) : undefined;
      const next = parseWebhookNext(rec.next, `${path}.next`);
      return {
        type: "webhook",
        url,
        method,
        timeoutMs,
        ...(headers ? { headers } : {}),
        ...(stringField(rec.failureReply) ? { failureReply: stringField(rec.failureReply) } : {}),
        ...(onFailure ? { onFailure } : {}),
        next,
      };
    }
    case "handoff_llm":
      return {
        type: "handoff_llm",
        ...(stringField(rec.systemPrompt) ? { systemPrompt: stringField(rec.systemPrompt) } : {}),
      };
    default:
      throw new HttpError(`${path}.type '${String(rec.type)}' is not a supported MenuAction.`, 400);
  }
}

function parseWebhookNext(value: unknown, path: string): WebhookNextAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(`${path} is required on webhook actions.`, 400);
  }
  const rec = value as Record<string, unknown>;
  if (rec.type === "end_call") return { type: "end_call" };
  if (rec.type === "goto") return { type: "goto", target: requireId(rec.target, `${path}.target`) };
  if (rec.type === "handoff_llm") {
    return {
      type: "handoff_llm",
      ...(stringField(rec.systemPrompt) ? { systemPrompt: stringField(rec.systemPrompt) } : {}),
    };
  }
  throw new HttpError(`${path}.type must be 'end_call', 'goto', or 'handoff_llm'.`, 400);
}

function parseFallbackAction(value: unknown, path: string): FallbackAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(`${path} must be an object.`, 400);
  }
  const rec = value as Record<string, unknown>;
  const reply = stringField(rec.reply);
  if (rec.type === "end_call") {
    return { type: "end_call", ...(reply ? { reply } : {}) };
  }
  if (rec.type === "goto") {
    return {
      type: "goto",
      target: requireId(rec.target, `${path}.target`),
      ...(reply ? { reply } : {}),
    };
  }
  if (rec.type === "transfer") {
    const target = stringField(rec.target);
    if (!target) throw new HttpError(`${path}.target is required.`, 400);
    const mode = parseTransferMode(rec.mode, `${path}.mode`);
    const metadata = rec.metadata !== undefined ? parseStringMap(rec.metadata, `${path}.metadata`) : undefined;
    return {
      type: "transfer",
      target,
      ...(mode ? { mode } : {}),
      ...(reply ? { reply } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }
  if (rec.type === "handoff_llm") {
    return {
      type: "handoff_llm",
      ...(stringField(rec.systemPrompt) ? { systemPrompt: stringField(rec.systemPrompt) } : {}),
      ...(reply ? { reply } : {}),
    };
  }
  throw new HttpError(`${path}.type '${String(rec.type)}' is not a valid fallback action.`, 400);
}

function parseEvalCase(
  value: unknown,
  idx: number,
  entry: string,
  initialStack: string[] | undefined,
  nodes: Record<string, MenuNode>,
  globals: MenuGlobals,
): MenuEvalCase {
  const path = `evals[${idx}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(`${path} must be an object.`, 400);
  }
  const rec = value as Record<string, unknown>;
  const say = stringField(rec.say);
  if (!say) throw new HttpError(`${path}.say is required.`, 400);
  const split = rec.split === undefined ? "tune" : rec.split;
  if (split !== "tune" && split !== "holdout") {
    throw new HttpError(`${path}.split must be 'tune' or 'holdout'.`, 400);
  }
  const nodeId = rec.node !== undefined ? requireId(rec.node, `${path}.node`) : entry;
  const node = hasOwn(nodes, nodeId) ? nodes[nodeId] : undefined;
  if (!node) {
    throw new HttpError(`${path}.node references unknown node '${nodeId}'.`, 400);
  }
  let stack: string[] | undefined;
  if (rec.stack !== undefined) {
    if (!Array.isArray(rec.stack)) throw new HttpError(`${path}.stack must be an array.`, 400);
    stack = rec.stack.map((s, sIdx) => {
      const sid = requireId(s, `${path}.stack[${sIdx}]`);
      if (!hasOwn(nodes, sid)) throw new HttpError(`${path}.stack[${sIdx}] references unknown node '${sid}'.`, 400);
      return sid;
    });
  } else if (nodeId === entry && initialStack && initialStack.length > 0) {
    stack = [...initialStack];
  }

  const effectiveDepth = stack?.length ?? 0;
  const expectVal = stringField(rec.expect);
  const validOptionIds = new Set(node.options.map((o) => o.id));
  const validGlobals = new Set<string>([UNCLEAR]);
  if (globals.repeat !== false) validGlobals.add(GLOBAL_REPEAT);
  if (effectiveDepth > 0 && globals.back !== false) validGlobals.add(GLOBAL_BACK);
  if (globals.operator && typeof globals.operator === "object") validGlobals.add(GLOBAL_OPERATOR);

  if (!validOptionIds.has(expectVal) && !validGlobals.has(expectVal)) {
    throw new HttpError(
      `${path}.expect '${expectVal}' is not a valid option or active global in node '${nodeId}'.`,
      400,
    );
  }

  let history: { role: "user" | "assistant"; text: string }[] | undefined;
  if (rec.history !== undefined) {
    if (!Array.isArray(rec.history)) throw new HttpError(`${path}.history must be an array.`, 400);
    history = rec.history.map((h, hIdx) => {
      if (!h || typeof h !== "object" || Array.isArray(h)) {
        throw new HttpError(`${path}.history[${hIdx}] must be an object.`, 400);
      }
      const hRec = h as Record<string, unknown>;
      if (hRec.role !== "user" && hRec.role !== "assistant") {
        throw new HttpError(`${path}.history[${hIdx}].role must be 'user' or 'assistant'.`, 400);
      }
      return { role: hRec.role, text: stringField(hRec.text) };
    });
  }

  let expectExtracted: Record<string, boolean | string | null> | undefined;
  if (rec.expectExtracted !== undefined) {
    if (!rec.expectExtracted || typeof rec.expectExtracted !== "object" || Array.isArray(rec.expectExtracted)) {
      throw new HttpError(`${path}.expectExtracted must be an object.`, 400);
    }
    expectExtracted = {};
    for (const [k, v] of Object.entries(rec.expectExtracted as Record<string, unknown>)) {
      if (typeof v !== "boolean" && typeof v !== "string" && v !== null) {
        throw new HttpError(`${path}.expectExtracted.${k} must be boolean, string, or null.`, 400);
      }
      setOwn(expectExtracted, k, v);
    }
  }

  return {
    ...(stringField(rec.id) ? { id: stringField(rec.id) } : {}),
    split,
    node: nodeId,
    ...(stack ? { stack } : {}),
    ...(history ? { history } : {}),
    say,
    expect: expectVal,
    ...(expectExtracted ? { expectExtracted } : {}),
  };
}

function assertTargetExists(
  action: FallbackAction | undefined,
  nodes: Record<string, MenuNode>,
  path: string,
): void {
  if (!action) return;
  if (action.type === "goto" && !hasOwn(nodes, action.target)) {
    throw new HttpError(`${path}.target references unknown node '${action.target}'.`, 400);
  }
}

function assertActionTargetsExist(action: MenuAction, nodes: Record<string, MenuNode>, path: string): void {
  if (action.type === "goto" && !hasOwn(nodes, action.target)) {
    throw new HttpError(`${path}.target references unknown node '${action.target}'.`, 400);
  }
  if (action.type === "webhook") {
    if (action.next.type === "goto" && !hasOwn(nodes, action.next.target)) {
      throw new HttpError(`${path}.next.target references unknown node '${action.next.target}'.`, 400);
    }
    assertTargetExists(action.onFailure, nodes, `${path}.onFailure`);
  }
}

function parseTransferMode(value: unknown, path: string): TransferMode | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "twilio_dial" || value === "daily_sip_refer" || value === "custom") return value;
  throw new HttpError(`${path} must be 'twilio_dial', 'daily_sip_refer', or 'custom'.`, 400);
}

function parseDtmf(value: unknown, path: string): DtmfKey {
  if (typeof value === "string" && VALID_DTMF.has(value)) return value as DtmfKey;
  throw new HttpError(`${path} must be a single DTMF key (0-9, *, #).`, 400);
}

function parseStringMap(value: unknown, path: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(`${path} must be an object of string values.`, 400);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") throw new HttpError(`${path}.${k} must be a string.`, 400);
    setOwn(out, k, v);
  }
  return out;
}

function requireId(value: unknown, path: string): string {
  const s = stringField(value);
  if (!s || !ID_PATTERN.test(s)) {
    throw new HttpError(`${path} must match /^[a-z0-9_]+$/ (got '${String(value ?? "")}').`, 400);
  }
  return s;
}

function parseProbability(value: unknown, defaultVal: number, path: string, strictPositive: boolean): number {
  if (value === undefined) return defaultVal;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(`${path} must be a finite number.`, 400);
  }
  if (strictPositive ? value <= 0 || value > 1 : value < 0 || value >= 1) {
    throw new HttpError(`${path} is out of valid probability bounds (0..1).`, 400);
  }
  return value;
}

function parsePositiveInt(value: unknown, defaultVal: number, path: string): number {
  if (value === undefined) return defaultVal;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HttpError(`${path} must be an integer >= 1.`, 400);
  }
  return value;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
