import {
  cloneRecord,
  CONFIDENCE,
  hasOwn,
  parseMenuGraph,
  presentDeeper,
  presentMenu,
  RESERVED_OPTION_IDS,
  setOwn,
  slugify,
  type MenuAction,
  type MenuGraph,
  type MenuNode,
  type MenuNodeOption,
} from "./menu";

export function createStarterGraph(): MenuGraph {
  const options: MenuNodeOption[] = [
    {
      id: "billing",
      title: "Billing",
      dtmf: "1",
      hints: "A charge, invoice, payment, or refund",
      reply: "Connecting you with billing.",
      action: { type: "transfer", target: "+18005550101", mode: "twilio_dial" },
    },
    {
      id: "support",
      title: "Support",
      dtmf: "2",
      hints: "Something is broken or they need help using the product",
      reply: "",
      action: {
        type: "handoff_llm",
        systemPrompt: "You are Northwind technical support. Help resolve the caller's product issue concisely.",
      },
    },
    {
      id: "hours",
      title: "Hours",
      dtmf: "3",
      hints: "Business hours, when we are open, holiday schedule, or address",
      reply: "We are open Monday through Friday, 8 AM to 6 PM Pacific. Goodbye!",
      action: { type: "end_call" },
    },
  ];

  return {
    version: 2,
    id: "northwind",
    name: "Northwind",
    entry: "main",
    confidenceThreshold: CONFIDENCE,
    maxUnclearTurns: 2,
    globals: { back: true, repeat: true },
    nodes: {
      main: {
        id: "main",
        name: "Northwind",
        script: presentMenu("Northwind", options),
        options,
      },
    },
  };
}

export function importMenuJson(rawJson: string): MenuGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }
  return parseMenuGraph(parsed);
}

export function exportMenuJson(graph: MenuGraph): string {
  // Validate canonical output before serializing
  const verified = parseMenuGraph(graph);
  return `${JSON.stringify(verified, null, 2)}\n`;
}

export function updateNodeFields(
  graph: MenuGraph,
  nodeId: string,
  patch: Partial<Pick<MenuNode, "name" | "script" | "reprompt" | "confidenceThreshold">>,
  rewriteAutoScript = false,
): MenuGraph {
  const current = hasOwn(graph.nodes, nodeId) ? graph.nodes[nodeId] : undefined;
  if (!current) return graph;
  const nextName = patch.name !== undefined ? patch.name : current.name;
  const nextScript =
    patch.script !== undefined
      ? patch.script
      : rewriteAutoScript
        ? nodeId === graph.entry
          ? presentMenu(nextName || graph.name, current.options)
          : presentDeeper(nextName, current.options)
        : current.script;

  const updatedNode: MenuNode = {
    ...current,
    ...patch,
    name: nextName,
    script: nextScript,
  };

  const nextNodes = cloneRecord(graph.nodes);
  setOwn(nextNodes, nodeId, updatedNode);

  return {
    ...graph,
    ...(nodeId === graph.entry && patch.name !== undefined ? { name: nextName } : {}),
    nodes: nextNodes,
  };
}

export function updateNodeOption(
  graph: MenuGraph,
  nodeId: string,
  optionId: string,
  patch: Partial<Omit<MenuNodeOption, "id">>,
  rewriteAutoScript = false,
): MenuGraph {
  const node = hasOwn(graph.nodes, nodeId) ? graph.nodes[nodeId] : undefined;
  if (!node) return graph;
  const nextOptions = node.options.map((opt) => (opt.id === optionId ? { ...opt, ...patch } : opt));
  const nextScript = rewriteAutoScript
    ? nodeId === graph.entry
      ? presentMenu(node.name || graph.name, nextOptions)
      : presentDeeper(node.name, nextOptions)
    : node.script;

  const nextNodes = cloneRecord(graph.nodes);
  setOwn(nextNodes, nodeId, {
    ...node,
    options: nextOptions,
    script: nextScript,
  });

  return {
    ...graph,
    nodes: nextNodes,
  };
}

export function addNodeOption(graph: MenuGraph, nodeId: string, title = "New Option"): MenuGraph {
  const node = hasOwn(graph.nodes, nodeId) ? graph.nodes[nodeId] : undefined;
  if (!node) return graph;
  const existingIds = new Set<string>([...RESERVED_OPTION_IDS, ...node.options.map((o) => o.id)]);
  let base = slugify(title);
  if (RESERVED_OPTION_IDS.has(base)) base = `${base}_option`;
  let id = base;
  let n = 2;
  while (existingIds.has(id)) {
    id = `${base}_${n}`;
    n += 1;
  }
  const newOpt: MenuNodeOption = {
    id,
    title,
    hints: "",
    reply: "",
    action: { type: "end_call" },
  };
  const nextNodes = cloneRecord(graph.nodes);
  setOwn(nextNodes, nodeId, {
    ...node,
    options: [...node.options, newOpt],
  });
  return {
    ...graph,
    nodes: nextNodes,
  };
}

export function removeNodeOption(graph: MenuGraph, nodeId: string, optionId: string): MenuGraph {
  const node = hasOwn(graph.nodes, nodeId) ? graph.nodes[nodeId] : undefined;
  if (!node || node.options.length <= 1) return graph;
  const nextOptions = node.options.filter((o) => o.id !== optionId);
  const nextEvals = graph.evals?.filter((ev) => !(ev.node === nodeId && ev.expect === optionId));
  const nextNodes = cloneRecord(graph.nodes);
  setOwn(nextNodes, nodeId, {
    ...node,
    options: nextOptions,
  });
  return {
    ...graph,
    nodes: nextNodes,
    ...(nextEvals ? { evals: nextEvals } : {}),
  };
}

export function addSubmenuNode(
  graph: MenuGraph,
  fromNodeId: string,
  fromOptionId: string,
  submenuName?: string,
): { graph: MenuGraph; createdNodeId: string } {
  const parent = hasOwn(graph.nodes, fromNodeId) ? graph.nodes[fromNodeId] : undefined;
  const option = parent?.options.find((o) => o.id === fromOptionId);
  const label = (submenuName ?? option?.title ?? "Submenu").trim() || "Submenu";
  let base = slugify(label);
  if (RESERVED_OPTION_IDS.has(base)) base = `${base}_menu`;
  let newNodeId = base;
  let n = 2;
  while (hasOwn(graph.nodes, newNodeId)) {
    newNodeId = `${base}_${n}`;
    n += 1;
  }

  const starterOpts: MenuNodeOption[] = [
    { id: "option_1", title: "Option 1", hints: "", reply: "Okay, Option 1.", action: { type: "end_call" } },
    { id: "option_2", title: "Option 2", hints: "", reply: "Okay, Option 2.", action: { type: "end_call" } },
  ];

  const newNode: MenuNode = {
    id: newNodeId,
    name: label,
    script: presentDeeper(label, starterOpts),
    options: starterOpts,
  };

  const nextNodes = cloneRecord(graph.nodes);
  setOwn(nextNodes, newNodeId, newNode);

  let nextGraph: MenuGraph = {
    ...graph,
    nodes: nextNodes,
  };

  if (parent && option) {
    nextGraph = updateNodeOption(nextGraph, fromNodeId, fromOptionId, {
      action: { type: "goto", target: newNodeId } satisfies MenuAction,
    });
  }

  return { graph: nextGraph, createdNodeId: newNodeId };
}

export function graphUsesHandoffLlm(graph: MenuGraph): boolean {
  if (graph.fallbackAction?.type === "handoff_llm") return true;
  if (
    graph.globals.operator &&
    typeof graph.globals.operator === "object" &&
    graph.globals.operator.action.type === "handoff_llm"
  ) {
    return true;
  }
  for (const node of Object.values(graph.nodes)) {
    for (const opt of node.options) {
      if (opt.action.type === "handoff_llm") return true;
      if (opt.action.type === "webhook") {
        if (opt.action.next.type === "handoff_llm" || opt.action.onFailure?.type === "handoff_llm") {
          return true;
        }
      }
    }
  }
  return false;
}

export function buildPipecatSnippet(graph: MenuGraph, filename = `${graph.id || "ivr"}.menu.json`): string {
  const hybrid = graphUsesHandoffLlm(graph);
  const lines = [
    "import os",
    "from pipecat.pipeline.pipeline import Pipeline",
    "from pipecat.processors.aggregators.llm_context import LLMContext",
    "from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair",
    "from pipecat.services.deepgram.stt import DeepgramSTTService",
    "from pipecat.services.deepgram.tts import DeepgramTTSService",
    ...(hybrid ? ["from pipecat.services.openai.llm import OpenAILLMService"] : []),
    "from pipecat_jev import JevMenuProcessor",
    "",
    "context = LLMContext()",
    "user_aggregator, assistant_aggregator = LLMContextAggregatorPair(context)",
    "",
    `ivr = JevMenuProcessor.from_file("${filename}", api_key=os.environ["TYPESAFE_API_KEY"])`,
    "",
    "pipeline = Pipeline([",
    "    transport.input(),",
    '    DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"]),',
    "    user_aggregator,",
    "    ivr,",
    ...(hybrid ? ['    OpenAILLMService(api_key=os.environ["OPENAI_API_KEY"]),'] : []),
    '    DeepgramTTSService(api_key=os.environ["DEEPGRAM_API_KEY"], voice="aura-2-asteria-en"),',
    "    transport.output(),",
    "    assistant_aggregator,",
    "])",
  ];
  return lines.join("\n");
}
