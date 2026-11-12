import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildJevGraphRequest, parseGraphPayload } from "../lib/jev";
import { parseMenuGraph, stepMenuTurn, validateMenuGraph, type MenuGraph } from "../lib/menu";
import {
  buildPipecatBundle,
  buildPipecatInitCommand,
  createZipArchive,
  defaultExportConfig,
  preferredTransferModeForPlatforms,
  validatePipecatExport,
  type PipecatPlatformId,
} from "../lib/pipecat-export";
import {
  alignGraphTransferModes,
  buildPipecatSnippet,
  createStarterGraph,
  exportMenuJson,
  importMenuJson,
  removeNodeOption,
  updateNodeOption,
} from "../lib/studio";

const fixtureRoot = join(process.cwd(), "schemas/fixtures");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;
const validFiles = readdirSync(join(fixtureRoot, "valid")).filter((x) => x.endsWith(".json"));
const invalidFiles = readdirSync(join(fixtureRoot, "invalid")).filter((x) => x.endsWith(".json"));
const base = parseMenuGraph(json(join(fixtureRoot, "valid/pure_ivr.json")));

test("shared valid and invalid fixtures conform to the TypeScript parser", () => {
  for (const file of validFiles) assert.doesNotThrow(() => parseMenuGraph(json(join(fixtureRoot, "valid", file))), file);
  for (const file of invalidFiles) assert.throws(() => parseMenuGraph(json(join(fixtureRoot, "invalid", file))), undefined, file);
});

test("v1 migration fixtures match their shared expected canonical v2 graphs", () => {
  for (const file of readdirSync(join(fixtureRoot, "v1-migration")).filter((x) => x.endsWith(".json") && !x.endsWith(".expected.json"))) {
    const actual = parseMenuGraph(json(join(fixtureRoot, "v1-migration", file)));
    const expected = json(join(fixtureRoot, "v1-migration", file.replace(/\.json$/, ".expected.json")));
    assert.deepEqual(actual, expected, file);
  }
});

test("validator identifies orphan nodes, trapped cycles, and UX warnings", () => {
  const orphan = structuredClone(base) as MenuGraph;
  orphan.nodes.orphan = { ...orphan.nodes.main, id: "orphan", name: "Orphan" };
  assert.ok(validateMenuGraph(orphan).errors.some((x) => x.code === "orphan_node"));
  const cycle = structuredClone(base) as MenuGraph;
  cycle.nodes.main.options = cycle.nodes.main.options.map((o) => ({ ...o, action: { type: "goto", target: "main" } }));
  assert.ok(validateMenuGraph(cycle).errors.some((x) => x.code === "trapped_cycle"));
  const warnings = validateMenuGraph(parseMenuGraph(json(join(fixtureRoot, "valid/pure_ivr.json"))));
  assert.ok(warnings.warnings.some((x) => x.code === "no_evals"));
});

test("Jev request carries node criteria and parsed secondary facts respect thresholds", () => {
  const graph = parseMenuGraph(json(join(fixtureRoot, "valid/secondary_questions.json")));
  const request = buildJevGraphRequest({ graph, nodeId: "main", turn: "yes please" });
  assert.ok("help" in (request.questions.option as { criteria: object }).criteria);
  const response = (noul: number) => parseGraphPayload({
    payload: { model: "resolved-test", answers: { option: { choice: "help", confidence: 0.9 }, eligible: { noul }, department: { choice: "billing", confidence: 0.9 } } },
    graph, nodeId: "main", extracted: { old_fact: "preserve" },
  });
  assert.equal(response(0.7).secondaryAnswers.eligible.value, true);
  assert.equal(response(0.3).secondaryAnswers.eligible.value, false);
  const mid = response(0.5);
  assert.equal(mid.secondaryAnswers.eligible.value, null);
  assert.equal(mid.extracted.old_fact, "preserve");
  assert.equal(mid.extracted.department, "billing");
});

test("menu reducer handles global back/repeat and unclear fallback", () => {
  const graph = parseMenuGraph(json(join(fixtureRoot, "valid/globals_dtmf.json")));
  const nested = parseMenuGraph(json(join(fixtureRoot, "valid/cyclic_submenus_exit_leaf.json")));
  const back = stepMenuTurn({ graph: nested, nodeId: "billing", stack: ["main"], choice: "global_back", confidence: 1 });
  assert.equal(back.nextNodeId, "main");
  assert.deepEqual(back.nextStack, []);
  const repeat = stepMenuTurn({ graph, nodeId: "main", choice: "global_repeat", confidence: 1 });
  const operator = stepMenuTurn({ graph, nodeId: "main", choice: "global_operator", confidence: 1 });
  assert.equal(operator.terminalAction?.type, "transfer");
  assert.match(repeat.spokenReply, /Welcome\./);
  const withFallback = structuredClone(base) as MenuGraph;
  withFallback.maxUnclearTurns = 1;
  withFallback.fallbackAction = { type: "end_call", reply: "Ending." };
  const result = stepMenuTurn({ graph: withFallback, nodeId: "main", choice: "unclear", confidence: 0, unclearStreak: 0 });
  assert.equal(result.terminalAction?.type, "end_call");
  assert.equal(result.spokenReply, "Ending.");
});

test("Studio import/export preserves v2 graphs, stable option IDs, evals, cycles and shared targets", () => {
  const graph = parseMenuGraph(json(join(fixtureRoot, "valid/cyclic_submenus_exit_leaf.json")));
  const roundTrip = importMenuJson(exportMenuJson(graph));
  assert.deepEqual(roundTrip, graph);
  const withEvals = structuredClone(graph) as MenuGraph;
  withEvals.evals = [{ split: "tune", node: "main", say: "help", expect: "help" }];
  const renamed = updateNodeOption(withEvals, "main", "help", { title: "Get assistance" });
  assert.equal(renamed.nodes.main.options[0].id, "help");
  assert.deepEqual(renamed.evals, withEvals.evals);
  assert.deepEqual(importMenuJson(exportMenuJson(renamed)), renamed);
  assert.deepEqual(removeNodeOption(renamed, "main", "help").evals, []);
  const pure = buildPipecatSnippet(base);
  const hybrid = buildPipecatSnippet(parseMenuGraph(json(join(fixtureRoot, "valid/handoff_llm.json"))));
  assert.doesNotMatch(pure, /OpenAILLMService/);
  assert.match(hybrid, /OpenAILLMService/);
});

test("Studio decide preview returns webhook and transfer actions without outbound action requests", async () => {
  const { POST } = await import("../app/api/decide/route");
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return Response.json({ answers: { option: { choice: "help", confidence: 0.99 } } });
  }) as typeof fetch;
  try {
    const webhookGraph = parseMenuGraph(json(join(fixtureRoot, "valid/webhook_failure.json")));
    const response = await POST(new Request("http://localhost/api/decide", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ menu: webhookGraph, text: "help" }),
    }));
    assert.equal(response.status, 200);
    const payload = await response.json() as { terminalAction?: { type: string; url?: string } };
    assert.equal(payload.terminalAction?.type, "webhook");
    const transferGraph = structuredClone(base) as MenuGraph;
    transferGraph.nodes.main.options[0].action = { type: "transfer", target: "+18005550123", mode: "twilio_dial" };
    const transferResponse = await POST(new Request("http://localhost/api/decide", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ menu: transferGraph, text: "help" }),
    }));
    const transferPayload = await transferResponse.json() as { terminalAction?: { type: string; target?: string } };
    assert.equal(transferPayload.terminalAction?.type, "transfer");
    assert.equal(transferPayload.terminalAction?.target, "+18005550123");
    assert.deepEqual(requested, ["https://api.typesafe.ai/v1/systemone", "https://api.typesafe.ai/v1/systemone"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  }
});

test("status route reports configured API keys", async () => {
  const { GET } = await import("../app/api/status/route");
  const previousJev = process.env.TYPESAFE_API_KEY;
  const previousDeepgram = process.env.DEEPGRAM_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.DEEPGRAM_API_KEY = "test-deepgram";
  try {
    const response = GET();
    assert.deepEqual(await response.json(), { jev: true, deepgram: true });
  } finally {
    if (previousJev === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousJev;
    if (previousDeepgram === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = previousDeepgram;
  }
});

test("decide API advances into a submenu and pops back with global_back", async () => {
  const { POST } = await import("../app/api/decide/route");
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  const choices = ["help", "global_back"];
  globalThis.fetch = (async () => Response.json({
    answers: { option: { choice: choices.shift(), confidence: 0.99 } },
  })) as typeof fetch;
  const graph = parseMenuGraph(json(join(fixtureRoot, "valid/cyclic_submenus_exit_leaf.json")));
  try {
    const firstResponse = await POST(new Request("http://localhost/api/decide", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ menu: graph, text: "billing please", history: [] }),
    }));
    const first = await firstResponse.json() as { nextNodeId: string; nextStack: string[] };
    assert.equal(first.nextNodeId, "billing");
    assert.deepEqual(first.nextStack, ["main"]);

    const secondResponse = await POST(new Request("http://localhost/api/decide", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        menu: graph, nodeId: first.nextNodeId, stack: first.nextStack,
        text: "go back", history: [{ role: "user", text: "billing please" }],
      }),
    }));
    const second = await secondResponse.json() as { outcomeChoice: string; nextNodeId: string; nextStack: string[] };
    assert.equal(second.outcomeChoice, "global_back");
    assert.equal(second.nextNodeId, "main");
    assert.deepEqual(second.nextStack, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  }
});

test("fallback goto provides a terminal exit from an otherwise trapped cycle", () => {
  const graph = structuredClone(base) as MenuGraph;
  graph.nodes.billing = {
    id: "billing", name: "Billing", script: "Billing.",
    options: [{ id: "done", title: "Done", hints: "finish", reply: "Done.", action: { type: "end_call" } }],
  };
  graph.nodes.main.options = graph.nodes.main.options.map((option) => ({
    ...option, action: { type: "goto", target: "main" },
  }));
  graph.fallbackAction = { type: "goto", target: "billing" };
  const report = validateMenuGraph(graph);
  assert.equal(report.errors.filter((issue) => issue.code === "trapped_cycle").length, 0);
});

test("prototype node keys are treated as graph data, not inherited properties", () => {
  const missingConstructor = structuredClone(base) as MenuGraph;
  missingConstructor.nodes.main.options[0].action = { type: "goto", target: "constructor" };
  assert.throws(() => parseMenuGraph(missingConstructor), /unknown node|does not exist/i);

  const protoGraph = JSON.parse(`{
    "version":2,"id":"proto","name":"Proto","entry":"__proto__",
    "confidenceThreshold":0.55,"maxUnclearTurns":2,
    "globals":{"back":true,"repeat":true},
    "nodes":{"__proto__":{"id":"__proto__","name":"Proto","script":"Hello.",
      "options":[{"id":"done","title":"Done","hints":"finish","reply":"Done.","action":{"type":"end_call"}}]}}
  }`) as unknown;
  const imported = importMenuJson(JSON.stringify(protoGraph));
  assert.equal(imported.entry, "__proto__");
  assert.equal(Object.hasOwn(imported.nodes, "__proto__"), true);
  const exported = JSON.parse(exportMenuJson(imported)) as { entry: string; nodes: Record<string, unknown> };
  assert.equal(exported.entry, "__proto__");
  assert.equal(Object.hasOwn(exported.nodes, "__proto__"), true);
  assert.equal(importMenuJson(JSON.stringify(exported)).nodes["__proto__"].id, "__proto__");
});

test("Pipecat export validation catches platform mismatches and alignGraphTransferModes resolves them", () => {
  const starter = createStarterGraph();
  const baseCfg = defaultExportConfig(starter);
  assert.deepEqual(baseCfg.platforms, ["twilio", "smallwebrtc"]);

  // Empty platform list warns immediately
  const emptyDiags = validatePipecatExport(starter, { ...baseCfg, platforms: [] });
  assert.ok(emptyDiags.some((d) => d.code === "no_platforms" && d.severity === "warning"));

  // Selecting Daily PSTN on a twilio_dial starter flags mismatch & suggests daily_sip_refer
  const dailyMismatch = validatePipecatExport(starter, { ...baseCfg, platforms: ["daily_pstn"] });
  const twilioMissing = dailyMismatch.find((d) => d.code === "transfer_mode_twilio_missing");
  assert.ok(twilioMissing);
  assert.equal(twilioMissing.suggestedTransferMode, "daily_sip_refer");

  // Aligning graph resolves twilio_dial mismatch cleanly
  const aligned = alignGraphTransferModes(starter, "daily_sip_refer");
  const afterAlign = validatePipecatExport(aligned, { ...baseCfg, platforms: ["daily_pstn"] });
  assert.ok(!afterAlign.some((d) => d.code === "transfer_mode_twilio_missing"));
  assert.ok(afterAlign.some((d) => d.code === "daily_pstn_dialin"));

  // Selecting Telnyx + LiveKit warns about @ivr.on_transfer custom hook
  const hookDiags = validatePipecatExport(aligned, { ...baseCfg, platforms: ["telnyx", "livekit"] });
  assert.ok(hookDiags.some((d) => d.code === "transfer_hook_required" && d.severity === "warning"));
  assert.ok(hookDiags.some((d) => d.code === "transfer_mode_daily_missing"));

  // SmallWebRTC-only warns on Pipecat Cloud and notes simulated transfer + DTMF
  const cloudWebOnly = validatePipecatExport(starter, {
    ...baseCfg,
    platforms: ["smallwebrtc"],
    deployTarget: "pipecat_cloud",
  });
  assert.ok(cloudWebOnly.some((d) => d.code === "cloud_smallwebrtc_only" && d.severity === "warning"));
  assert.ok(cloudWebOnly.some((d) => d.code === "web_only_simulated_transfer" && d.severity === "info"));
  assert.ok(cloudWebOnly.some((d) => d.code === "dtmf_needs_telephony" && d.severity === "info"));
  assert.ok(cloudWebOnly.some((d) => d.code === "cloud_placeholder_image" && d.severity === "info"));

  // Local Krisp notes KRISP_VIVA_FILTER_MODEL_PATH + krisp_audio
  const krispLocal = validatePipecatExport(base, { ...baseCfg, platforms: ["daily"], enableKrisp: true });
  assert.ok(krispLocal.some((d) => d.code === "krisp_local_sdk" && d.severity === "info"));

  assert.equal(preferredTransferModeForPlatforms(["twilio", "telnyx"]), "twilio_dial");
  assert.equal(preferredTransferModeForPlatforms(["daily_pstn"]), "daily_sip_refer");
  assert.equal(preferredTransferModeForPlatforms(["telnyx", "livekit"]), "custom");
});

test("Pipecat bundle generator supports all platforms, services, Pure vs Hybrid IVR, Cloud files, and ZIP archives", () => {
  const starter = createStarterGraph();

  // Pure IVR with ElevenLabs TTS, AssemblyAI STT, Daily PSTN + SmallWebRTC + Pipecat Cloud + Krisp
  const cloudConfig = {
    ...defaultExportConfig(starter),
    platforms: ["daily_pstn", "daily", "smallwebrtc"] as PipecatPlatformId[],
    stt: "assemblyai" as const,
    tts: "elevenlabs" as const,
    llm: "anthropic" as const,
    deployTarget: "pipecat_cloud" as const,
    enableKrisp: true,
    enableMetrics: false,
  };
  const pureFiles = buildPipecatBundle(base, cloudConfig);
  const paths = pureFiles.map((f) => f.path);
  assert.deepEqual(paths, [
    "bot.py",
    "menu.json",
    "pyproject.toml",
    ".env.example",
    "README.md",
    "pcc-deploy.toml",
    "Dockerfile",
  ]);

  const pureBot = pureFiles.find((f) => f.path === "bot.py")!.content;
  assert.match(pureBot, /AssemblyAISTTService/);
  assert.match(pureBot, /ElevenLabsTTSService/);
  assert.doesNotMatch(pureBot, /AnthropicLLMService/);
  assert.match(pureBot, /KrispVivaFilter\(\)/);
  assert.match(pureBot, /DailySipTransferAdapter/);
  assert.match(pureBot, /enable_metrics=False/);
  // Daily + daily_pstn deduplicate to a single "daily" key in transport_params
  assert.equal(pureBot.match(/"daily": lambda: DailyParams/g)?.length, 1);

  const purePyproject = pureFiles.find((f) => f.path === "pyproject.toml")!.content;
  assert.match(purePyproject, /pipecat-ai\[assemblyai,daily,elevenlabs,runner,silero,webrtc\]/);
  assert.doesNotMatch(purePyproject, /anthropic/);

  const pureEnv = pureFiles.find((f) => f.path === ".env.example")!.content;
  assert.match(pureEnv, /ASSEMBLYAI_API_KEY=/);
  assert.match(pureEnv, /ELEVENLABS_API_KEY=/);
  assert.match(pureEnv, /KRISP_VIVA_API_KEY=/);
  assert.match(pureEnv, /KRISP_VIVA_FILTER_MODEL_PATH=/);
  assert.doesNotMatch(pureEnv, /ANTHROPIC_API_KEY=/);

  const pccToml = pureFiles.find((f) => f.path === "pcc-deploy.toml")!.content;
  assert.match(pccToml, /enable_krisp = true/);

  // Hybrid IVR with custom hook platforms (Telnyx + LiveKit + Vonage + MOQ) emits LLM & @ivr.on_transfer
  const hybridBundle = buildPipecatBundle(starter, {
    ...defaultExportConfig(starter),
    platforms: ["telnyx", "livekit", "vonage", "moq"],
    stt: "cartesia",
    tts: "rime",
    llm: "anthropic",
    deployTarget: "local",
  });
  assert.equal(hybridBundle.some((f) => f.path === "pcc-deploy.toml"), false);
  const hybridBot = hybridBundle.find((f) => f.path === "bot.py")!.content;
  assert.match(hybridBot, /AnthropicLLMService/);
  assert.match(hybridBot, /@ivr\.on_transfer/);
  assert.match(hybridBot, /LiveKitParams/);
  assert.match(hybridBot, /MOQParams/);
  assert.match(hybridBot, /VonageVideoConnectorTransportParams/);

  // CLI command reflection
  const cli = buildPipecatInitCommand(starter, cloudConfig);
  assert.match(cli, /--bot-type telephony/);
  assert.match(cli, /--transport daily_pstn/);
  assert.match(cli, /--deploy-to-cloud/);
  assert.match(cli, /--enable-krisp/);

  // ZIP binary structure check (PK\x03\x04 start + PK\x05\x06 EOCD + all filenames)
  const zipBytes = createZipArchive(pureFiles);
  assert.equal(zipBytes[0], 0x50);
  assert.equal(zipBytes[1], 0x4b);
  assert.equal(zipBytes[2], 0x03);
  assert.equal(zipBytes[3], 0x04);
  const zipText = Buffer.from(zipBytes).toString("latin1");
  for (const f of pureFiles) {
    assert.ok(zipText.includes(f.path), `missing ${f.path} in ZIP archive`);
  }
});
