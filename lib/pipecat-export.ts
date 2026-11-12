import { parseMenuGraph, type FallbackAction, type MenuAction, type MenuGraph } from "./menu";

export type PipecatPlatformId =
  | "twilio"
  | "daily_pstn"
  | "telnyx"
  | "plivo"
  | "exotel"
  | "vonage"
  | "smallwebrtc"
  | "daily"
  | "livekit"
  | "websocket"
  | "moq";

export type PipecatSttId = "deepgram" | "assemblyai" | "cartesia" | "openai" | "google";
export type PipecatTtsId = "deepgram" | "cartesia" | "elevenlabs" | "openai" | "rime";
export type PipecatLlmId = "openai" | "anthropic" | "google" | "groq";
export type PipecatDeployTarget = "local" | "pipecat_cloud";
export type DailyPstnMode = "dial-in" | "dial-out";

export type PipecatExportConfig = {
  platforms: PipecatPlatformId[];
  dailyPstnMode: DailyPstnMode;
  stt: PipecatSttId;
  tts: PipecatTtsId;
  llm: PipecatLlmId;
  deployTarget: PipecatDeployTarget;
  agentName: string;
  secretSet: string;
  image: string;
  enableKrisp: boolean;
  enableMetrics: boolean;
};

export type ExportDiagnostic = {
  severity: "warning" | "info";
  code: string;
  message: string;
  nodeId?: string;
  optionId?: string;
  suggestedTransferMode?: "twilio_dial" | "daily_sip_refer" | "custom";
};

export type PipecatBundleFile = {
  path: string;
  language: "python" | "json" | "toml" | "dockerfile" | "env" | "markdown";
  content: string;
};

export type PlatformSpec = {
  id: PipecatPlatformId;
  label: string;
  category: "telephony" | "web";
  transportKey: string;
  pipecatInitTransport: string;
  extra: string;
  supportsDtmf: boolean;
  builtInTransferMode: "twilio_dial" | "daily_sip_refer" | null;
  requiresTransferHook: boolean;
  envVars: { key: string; comment: string; placeholder?: string }[];
  notes: string;
};

export const PIPECAT_PLATFORMS: PlatformSpec[] = [
  {
    id: "twilio",
    label: "Twilio Media Streams",
    category: "telephony",
    transportKey: "twilio",
    pipecatInitTransport: "twilio",
    extra: "websocket",
    supportsDtmf: true,
    builtInTransferMode: "twilio_dial",
    requiresTransferHook: false,
    envVars: [
      { key: "TWILIO_ACCOUNT_SID", comment: "Twilio Account SID for Media Streams & <Dial> transfers" },
      { key: "TWILIO_AUTH_TOKEN", comment: "Twilio Auth Token (or set TWILIO_API_KEY + TWILIO_API_SECRET)" },
    ],
    notes: "Built-in TwilioTransferAdapter (<Dial> + safe auto_hang_up release).",
  },
  {
    id: "daily_pstn",
    label: "Daily PSTN / SIP",
    category: "telephony",
    transportKey: "daily",
    pipecatInitTransport: "daily_pstn",
    extra: "daily",
    supportsDtmf: true,
    builtInTransferMode: "daily_sip_refer",
    requiresTransferHook: false,
    envVars: [{ key: "DAILY_API_KEY", comment: "Daily API key for PSTN/SIP rooms and pinless dial-in" }],
    notes: "Built-in DailySipTransferAdapter (ordered DailySIPReferFrame).",
  },
  {
    id: "telnyx",
    label: "Telnyx",
    category: "telephony",
    transportKey: "telnyx",
    pipecatInitTransport: "telnyx",
    extra: "websocket",
    supportsDtmf: true,
    builtInTransferMode: null,
    requiresTransferHook: true,
    envVars: [{ key: "TELNYX_API_KEY", comment: "Telnyx API v2 key for Call Control & serializer auto_hang_up" }],
    notes: "Native DTMF via TelnyxFrameSerializer; transfers use @ivr.on_transfer.",
  },
  {
    id: "plivo",
    label: "Plivo",
    category: "telephony",
    transportKey: "plivo",
    pipecatInitTransport: "plivo",
    extra: "websocket",
    supportsDtmf: true,
    builtInTransferMode: null,
    requiresTransferHook: true,
    envVars: [
      { key: "PLIVO_AUTH_ID", comment: "Plivo Auth ID" },
      { key: "PLIVO_AUTH_TOKEN", comment: "Plivo Auth Token" },
    ],
    notes: "Native DTMF via PlivoFrameSerializer; transfers use @ivr.on_transfer.",
  },
  {
    id: "exotel",
    label: "Exotel",
    category: "telephony",
    transportKey: "exotel",
    pipecatInitTransport: "exotel",
    extra: "websocket",
    supportsDtmf: true,
    builtInTransferMode: null,
    requiresTransferHook: true,
    envVars: [],
    notes: "Native DTMF via ExotelFrameSerializer; transfers use @ivr.on_transfer.",
  },
  {
    id: "vonage",
    label: "Vonage Connector",
    category: "telephony",
    transportKey: "vonage",
    pipecatInitTransport: "vonage",
    extra: "vonage-video-connector",
    supportsDtmf: true,
    builtInTransferMode: null,
    requiresTransferHook: true,
    envVars: [
      { key: "VONAGE_APPLICATION_ID", comment: "Vonage Application ID" },
      { key: "VONAGE_PRIVATE_KEY", comment: "Vonage private key path or PEM" },
    ],
    notes: "VonageVideoConnectorTransport; transfers use @ivr.on_transfer.",
  },
  {
    id: "smallwebrtc",
    label: "SmallWebRTC (Local / Dev)",
    category: "web",
    transportKey: "webrtc",
    pipecatInitTransport: "smallwebrtc",
    extra: "webrtc",
    supportsDtmf: false,
    builtInTransferMode: null,
    requiresTransferHook: false,
    envVars: [],
    notes: "Browser WebRTC auditioning with SimulatedTransferAdapter.",
  },
  {
    id: "daily",
    label: "Daily WebRTC",
    category: "web",
    transportKey: "daily",
    pipecatInitTransport: "daily",
    extra: "daily",
    supportsDtmf: true,
    builtInTransferMode: null,
    requiresTransferHook: false,
    envVars: [{ key: "DAILY_API_KEY", comment: "Daily API key for creating rooms and tokens" }],
    notes: "Managed Daily WebRTC rooms; ideal for web clients & Pipecat Cloud.",
  },
  {
    id: "livekit",
    label: "LiveKit",
    category: "web",
    transportKey: "livekit",
    pipecatInitTransport: "livekit",
    extra: "livekit",
    supportsDtmf: true,
    builtInTransferMode: null,
    requiresTransferHook: true,
    envVars: [
      { key: "LIVEKIT_URL", comment: "LiveKit WebSocket URL (wss://...)" },
      { key: "LIVEKIT_API_KEY", comment: "LiveKit API key" },
      { key: "LIVEKIT_API_SECRET", comment: "LiveKit API secret" },
    ],
    notes: "LiveKit room transport; SIP transfers use @ivr.on_transfer.",
  },
  {
    id: "websocket",
    label: "FastAPI WebSocket",
    category: "web",
    transportKey: "websocket",
    pipecatInitTransport: "websocket",
    extra: "websocket",
    supportsDtmf: false,
    builtInTransferMode: null,
    requiresTransferHook: true,
    envVars: [],
    notes: "Custom client WebSocket streaming (RTVI / Protobuf).",
  },
  {
    id: "moq",
    label: "MOQ (WebTransport)",
    category: "web",
    transportKey: "moq",
    pipecatInitTransport: "moq",
    extra: "moq",
    supportsDtmf: false,
    builtInTransferMode: null,
    requiresTransferHook: true,
    envVars: [],
    notes: "Media over QUIC relay/server transport.",
  },
];

export const PLATFORM_MAP = new Map<PipecatPlatformId, PlatformSpec>(
  PIPECAT_PLATFORMS.map((spec) => [spec.id, spec]),
);

type ServiceSpec<T extends string> = {
  id: T;
  label: string;
  pipecatInitFlag: string;
  importPath: string;
  className: string;
  initExpr: string;
  extra: string;
  envVars: { key: string; comment: string; placeholder?: string }[];
};

export const STT_SERVICES: ServiceSpec<PipecatSttId>[] = [
  {
    id: "deepgram",
    label: "Deepgram (Nova / Flux)",
    pipecatInitFlag: "deepgram_stt",
    importPath: "pipecat.services.deepgram.stt",
    className: "DeepgramSTTService",
    initExpr: 'DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"])',
    extra: "deepgram",
    envVars: [{ key: "DEEPGRAM_API_KEY", comment: "Deepgram API key for STT/TTS" }],
  },
  {
    id: "assemblyai",
    label: "AssemblyAI",
    pipecatInitFlag: "assemblyai_stt",
    importPath: "pipecat.services.assemblyai.stt",
    className: "AssemblyAISTTService",
    initExpr: 'AssemblyAISTTService(api_key=os.environ["ASSEMBLYAI_API_KEY"])',
    extra: "assemblyai",
    envVars: [{ key: "ASSEMBLYAI_API_KEY", comment: "AssemblyAI API key for streaming STT" }],
  },
  {
    id: "cartesia",
    label: "Cartesia (Ink)",
    pipecatInitFlag: "cartesia_stt",
    importPath: "pipecat.services.cartesia.stt",
    className: "CartesiaSTTService",
    initExpr: 'CartesiaSTTService(api_key=os.environ["CARTESIA_API_KEY"])',
    extra: "cartesia",
    envVars: [{ key: "CARTESIA_API_KEY", comment: "Cartesia API key" }],
  },
  {
    id: "openai",
    label: "OpenAI STT",
    pipecatInitFlag: "openai_stt",
    importPath: "pipecat.services.openai.stt",
    className: "OpenAISTTService",
    initExpr: 'OpenAISTTService(api_key=os.environ["OPENAI_API_KEY"])',
    extra: "openai",
    envVars: [{ key: "OPENAI_API_KEY", comment: "OpenAI API key" }],
  },
  {
    id: "google",
    label: "Google Cloud STT",
    pipecatInitFlag: "google_stt",
    importPath: "pipecat.services.google.stt",
    className: "GoogleSTTService",
    initExpr: 'GoogleSTTService(credentials_path=os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"))',
    extra: "google",
    envVars: [{ key: "GOOGLE_APPLICATION_CREDENTIALS", comment: "Path to Google Cloud service account JSON" }],
  },
];

export const TTS_SERVICES: ServiceSpec<PipecatTtsId>[] = [
  {
    id: "deepgram",
    label: "Deepgram Aura 2",
    pipecatInitFlag: "deepgram_tts",
    importPath: "pipecat.services.deepgram.tts",
    className: "DeepgramTTSService",
    initExpr: 'DeepgramTTSService(api_key=os.environ["DEEPGRAM_API_KEY"], voice="aura-2-asteria-en")',
    extra: "deepgram",
    envVars: [{ key: "DEEPGRAM_API_KEY", comment: "Deepgram API key for STT/TTS" }],
  },
  {
    id: "cartesia",
    label: "Cartesia Sonic",
    pipecatInitFlag: "cartesia_tts",
    importPath: "pipecat.services.cartesia.tts",
    className: "CartesiaTTSService",
    initExpr:
      'CartesiaTTSService(api_key=os.environ["CARTESIA_API_KEY"], voice_id=os.environ.get("CARTESIA_VOICE_ID", "71a7ad14-091c-4e8e-a314-022ece01c121"))',
    extra: "cartesia",
    envVars: [{ key: "CARTESIA_API_KEY", comment: "Cartesia API key" }],
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    pipecatInitFlag: "elevenlabs_tts",
    importPath: "pipecat.services.elevenlabs.tts",
    className: "ElevenLabsTTSService",
    initExpr:
      'ElevenLabsTTSService(api_key=os.environ["ELEVENLABS_API_KEY"], voice_id=os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"))',
    extra: "elevenlabs",
    envVars: [{ key: "ELEVENLABS_API_KEY", comment: "ElevenLabs API key" }],
  },
  {
    id: "openai",
    label: "OpenAI TTS",
    pipecatInitFlag: "openai_tts",
    importPath: "pipecat.services.openai.tts",
    className: "OpenAITTSService",
    initExpr: 'OpenAITTSService(api_key=os.environ["OPENAI_API_KEY"], voice="alloy")',
    extra: "openai",
    envVars: [{ key: "OPENAI_API_KEY", comment: "OpenAI API key" }],
  },
  {
    id: "rime",
    label: "Rime",
    pipecatInitFlag: "rime_tts",
    importPath: "pipecat.services.rime.tts",
    className: "RimeTTSService",
    initExpr: 'RimeTTSService(api_key=os.environ["RIME_API_KEY"], voice_id=os.environ.get("RIME_VOICE_ID", "luna"))',
    extra: "rime",
    envVars: [{ key: "RIME_API_KEY", comment: "Rime TTS API key" }],
  },
];

export const LLM_SERVICES: ServiceSpec<PipecatLlmId>[] = [
  {
    id: "openai",
    label: "OpenAI",
    pipecatInitFlag: "openai_llm",
    importPath: "pipecat.services.openai.llm",
    className: "OpenAILLMService",
    initExpr: 'OpenAILLMService(api_key=os.environ["OPENAI_API_KEY"])',
    extra: "openai",
    envVars: [{ key: "OPENAI_API_KEY", comment: "OpenAI API key for specialist handoff_llm branches" }],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    pipecatInitFlag: "anthropic_llm",
    importPath: "pipecat.services.anthropic.llm",
    className: "AnthropicLLMService",
    initExpr: 'AnthropicLLMService(api_key=os.environ["ANTHROPIC_API_KEY"])',
    extra: "anthropic",
    envVars: [{ key: "ANTHROPIC_API_KEY", comment: "Anthropic API key for specialist handoff_llm branches" }],
  },
  {
    id: "google",
    label: "Google Gemini",
    pipecatInitFlag: "google_llm",
    importPath: "pipecat.services.google.llm",
    className: "GoogleLLMService",
    initExpr: 'GoogleLLMService(api_key=os.environ["GOOGLE_API_KEY"])',
    extra: "google",
    envVars: [{ key: "GOOGLE_API_KEY", comment: "Google Gemini API key for specialist handoff_llm branches" }],
  },
  {
    id: "groq",
    label: "Groq",
    pipecatInitFlag: "groq_llm",
    importPath: "pipecat.services.groq.llm",
    className: "GroqLLMService",
    initExpr: 'GroqLLMService(api_key=os.environ["GROQ_API_KEY"])',
    extra: "groq",
    envVars: [{ key: "GROQ_API_KEY", comment: "Groq API key for specialist handoff_llm branches" }],
  },
];

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

function sanitizeAgentSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "voice-ivr";
}

function collectTransferActions(graph: MenuGraph): {
  nodeId?: string;
  optionId?: string;
  mode: "twilio_dial" | "daily_sip_refer" | "custom";
  target: string;
}[] {
  const transfers: {
    nodeId?: string;
    optionId?: string;
    mode: "twilio_dial" | "daily_sip_refer" | "custom";
    target: string;
  }[] = [];

  const inspectFallback = (fb: FallbackAction | undefined) => {
    if (fb?.type === "transfer") {
      transfers.push({ mode: fb.mode ?? "custom", target: fb.target });
    }
  };

  inspectFallback(graph.fallbackAction);
  if (graph.globals.operator && typeof graph.globals.operator === "object") {
    inspectFallback(graph.globals.operator.action);
  }

  for (const node of Object.values(graph.nodes)) {
    for (const opt of node.options) {
      if (opt.action.type === "transfer") {
        transfers.push({
          nodeId: node.id,
          optionId: opt.id,
          mode: opt.action.mode ?? "custom",
          target: opt.action.target,
        });
      } else if (opt.action.type === "webhook") {
        inspectFallback(opt.action.onFailure);
      }
    }
  }

  return transfers;
}

function graphHasDtmf(graph: MenuGraph): boolean {
  if (
    (typeof graph.globals.back === "object" && graph.globals.back.dtmf) ||
    (typeof graph.globals.repeat === "object" && graph.globals.repeat.dtmf) ||
    (typeof graph.globals.operator === "object" && graph.globals.operator.dtmf)
  ) {
    return true;
  }
  return Object.values(graph.nodes).some((node) => node.options.some((opt) => Boolean(opt.dtmf)));
}

export function defaultExportConfig(graph: MenuGraph): PipecatExportConfig {
  const transfers = collectTransferActions(graph);
  const hasDailySip = transfers.some((t) => t.mode === "daily_sip_refer");
  const hasTwilio = transfers.some((t) => t.mode === "twilio_dial");
  const platforms: PipecatPlatformId[] = hasDailySip
    ? ["daily_pstn", "smallwebrtc"]
    : hasTwilio
      ? ["twilio", "smallwebrtc"]
      : ["smallwebrtc"];
  const slug = sanitizeAgentSlug(graph.id || "voice_ivr");

  return {
    platforms,
    dailyPstnMode: "dial-in",
    stt: "deepgram",
    tts: "deepgram",
    llm: "openai",
    deployTarget: "local",
    agentName: slug,
    secretSet: `${slug}-secrets`,
    image: `your-dockerhub-user/${slug}:0.1`,
    enableKrisp: false,
    enableMetrics: true,
  };
}

export function preferredTransferModeForPlatforms(
  platforms: PipecatPlatformId[],
): "twilio_dial" | "daily_sip_refer" | "custom" {
  if (platforms.includes("twilio")) return "twilio_dial";
  if (platforms.includes("daily_pstn")) return "daily_sip_refer";
  return "custom";
}

export function validatePipecatExport(
  graph: MenuGraph,
  config: PipecatExportConfig,
): ExportDiagnostic[] {
  const diagnostics: ExportDiagnostic[] = [];
  const selected = new Set(config.platforms);

  if (selected.size === 0) {
    diagnostics.push({
      severity: "warning",
      code: "no_platforms",
      message: "Select at least one Pipecat transport platform to generate bot.py and pyproject.toml.",
    });
    return diagnostics;
  }

  const transfers = collectTransferActions(graph);
  const hasDaily = selected.has("daily_pstn") || selected.has("daily");
  const hasTwilio = selected.has("twilio");
  const preferredMode = preferredTransferModeForPlatforms(config.platforms);

  if (transfers.length > 0) {
    const twilioMismatches = transfers.filter((t) => t.mode === "twilio_dial" && !hasTwilio);
    if (twilioMismatches.length > 0) {
      const sample = twilioMismatches[0];
      diagnostics.push({
        severity: "warning",
        code: "transfer_mode_twilio_missing",
        nodeId: sample.nodeId,
        optionId: sample.optionId,
        suggestedTransferMode: preferredMode,
        message: `${twilioMismatches.length} transfer action(s) use mode "twilio_dial", but Twilio Media Streams is not selected.`,
      });
    }

    const dailyMismatches = transfers.filter((t) => t.mode === "daily_sip_refer" && !hasDaily);
    if (dailyMismatches.length > 0) {
      const sample = dailyMismatches[0];
      diagnostics.push({
        severity: "warning",
        code: "transfer_mode_daily_missing",
        nodeId: sample.nodeId,
        optionId: sample.optionId,
        suggestedTransferMode: preferredMode,
        message: `${dailyMismatches.length} transfer action(s) use mode "daily_sip_refer", but Daily PSTN / Daily is not selected.`,
      });
    }

    const hookPlatforms = config.platforms.filter((id) => PLATFORM_MAP.get(id)?.requiresTransferHook);
    if (hookPlatforms.length > 0) {
      const labels = hookPlatforms.map((id) => PLATFORM_MAP.get(id)?.label ?? id).join(", ");
      diagnostics.push({
        severity: "warning",
        code: "transfer_hook_required",
        message: `${labels} do not have a built-in transfer adapter in pipecat-jev yet; the generated bot.py scaffolds an @ivr.on_transfer hook for you to connect their REST/SIP transfer API.`,
      });
    }

    const anyTelephony = config.platforms.some((id) => PLATFORM_MAP.get(id)?.category === "telephony");
    if (!anyTelephony) {
      diagnostics.push({
        severity: "info",
        code: "web_only_simulated_transfer",
        message:
          "Only web transports are selected, so transfer actions will execute via SimulatedTransferAdapter (safe no-op logging).",
      });
    }
  }

  if (graphHasDtmf(graph)) {
    const anyDtmfPlatform = config.platforms.some((id) => PLATFORM_MAP.get(id)?.supportsDtmf);
    if (!anyDtmfPlatform) {
      diagnostics.push({
        severity: "info",
        code: "dtmf_needs_telephony",
        message:
          "This graph defines DTMF keys, which fire automatically on telephony/Daily/LiveKit transports. SmallWebRTC/WebSocket clients only send DTMF if your client injects InputDTMFFrame.",
      });
    }
  }

  if (selected.has("daily_pstn") && config.dailyPstnMode === "dial-in") {
    diagnostics.push({
      severity: "info",
      code: "daily_pstn_dialin",
      message:
        "Daily PSTN dial-in expects DailyDialinRequest inside runner_args.body (Pipecat Cloud and `pipecat.runner.run` wire this into DailyParams automatically via create_transport).",
    });
  }

  if (config.enableKrisp && config.deployTarget === "local") {
    diagnostics.push({
      severity: "info",
      code: "krisp_local_sdk",
      message:
        "Local KrispVivaFilter requires installing the Krisp VIVA `krisp_audio` wheel plus KRISP_VIVA_API_KEY and KRISP_VIVA_FILTER_MODEL_PATH (.kef model file). On Pipecat Cloud, `enable_krisp = true` provisions it automatically.",
    });
  }

  if (config.deployTarget === "pipecat_cloud") {
    if (!config.image.trim() || config.image.includes("your-dockerhub-user")) {
      diagnostics.push({
        severity: "info",
        code: "cloud_placeholder_image",
        message:
          "Update `image` in pcc-deploy.toml to your registry repository (or use Cloud Build via `pipecat cloud deploy --force`).",
      });
    }
    if (config.platforms.length === 1 && selected.has("smallwebrtc")) {
      diagnostics.push({
        severity: "warning",
        code: "cloud_smallwebrtc_only",
        message:
          "Pipecat Cloud production bots typically use Daily, Daily PSTN, or a telephony WebSocket transport (Twilio/Telnyx/Plivo) rather than SmallWebRTC alone.",
      });
    }
  }

  return diagnostics;
}

export function buildPipecatInitCommand(graph: MenuGraph, config: PipecatExportConfig): string {
  const stt = STT_SERVICES.find((s) => s.id === config.stt) ?? STT_SERVICES[0];
  const tts = TTS_SERVICES.find((s) => s.id === config.tts) ?? TTS_SERVICES[0];
  const llm = LLM_SERVICES.find((s) => s.id === config.llm) ?? LLM_SERVICES[0];
  const slug = sanitizeAgentSlug(config.agentName || graph.id || "voice_ivr").replace(/-/g, "_");

  const selected = config.platforms.length > 0 ? config.platforms : (["smallwebrtc"] as PipecatPlatformId[]);
  const hasTelephony = selected.some((id) => PLATFORM_MAP.get(id)?.category === "telephony");
  const transportFlags = Array.from(
    new Set(selected.map((id) => PLATFORM_MAP.get(id)?.pipecatInitTransport ?? id)),
  )
    .map((t) => `--transport ${t}`)
    .join(" ");

  const parts = [
    `pipecat init ${slug}`,
    `--bot-type ${hasTelephony ? "telephony" : "web"}`,
    transportFlags,
    "--mode cascade",
    `--stt ${stt.pipecatInitFlag}`,
    `--tts ${tts.pipecatInitFlag}`,
    `--llm ${llm.pipecatInitFlag}`,
    selected.includes("daily_pstn") ? `--daily-pstn-mode ${config.dailyPstnMode}` : "",
    config.deployTarget === "pipecat_cloud" ? "--deploy-to-cloud" : "--no-deploy-to-cloud",
    config.enableKrisp ? "--enable-krisp" : "",
  ].filter(Boolean);

  return parts.join(" \\\n  ");
}

function buildTransportImportsAndParams(config: PipecatExportConfig): {
  imports: string[];
  transportParamsEntries: string[];
  transferWiringLines: string[];
} {
  const selected = new Set<PipecatPlatformId>(
    config.platforms.length > 0 ? config.platforms : ["smallwebrtc"],
  );
  const imports: string[] = [];
  const runnerArgTypes = new Set<string>(["RunnerArguments"]);
  const transportParamsEntries: string[] = [];
  const transferWiringLines: string[] = [];

  const filterExpr = config.enableKrisp ? "KrispVivaFilter()" : "";
  const filterArg = filterExpr ? `, audio_in_filter=${filterExpr}` : "";

  const needsFastApiWs =
    selected.has("twilio") ||
    selected.has("telnyx") ||
    selected.has("plivo") ||
    selected.has("exotel") ||
    selected.has("websocket");
  const needsDaily = selected.has("daily") || selected.has("daily_pstn");

  if (needsDaily) {
    imports.push("from pipecat.transports.daily.transport import DailyParams");
    transportParamsEntries.push(
      `        "daily": lambda: DailyParams(audio_in_enabled=True, audio_out_enabled=True${filterArg}),`,
    );
  }
  if (selected.has("smallwebrtc")) {
    imports.push("from pipecat.transports.base_transport import TransportParams");
    transportParamsEntries.push(
      `        "webrtc": lambda: TransportParams(audio_in_enabled=True, audio_out_enabled=True${filterArg}),`,
    );
  }
  if (selected.has("livekit")) {
    imports.push("from pipecat.transports.livekit.transport import LiveKitParams");
    transportParamsEntries.push(
      `        "livekit": lambda: LiveKitParams(audio_in_enabled=True, audio_out_enabled=True${filterArg}),`,
    );
  }
  if (selected.has("moq")) {
    imports.push("from pipecat.transports.moq.transport import MOQParams");
    transportParamsEntries.push(
      `        "moq": lambda: MOQParams(audio_in_enabled=True, audio_out_enabled=True${filterArg}),`,
    );
  }
  if (selected.has("vonage")) {
    imports.push(
      "from pipecat.transports.vonage.video_connector import VonageVideoConnectorTransportParams",
    );
    transportParamsEntries.push(
      `        "vonage": lambda: VonageVideoConnectorTransportParams(audio_in_enabled=True, audio_out_enabled=True${filterArg}),`,
    );
  }
  if (needsFastApiWs) {
    imports.push("from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams");
    const wsKeys = (["twilio", "telnyx", "plivo", "exotel", "websocket"] as const).filter((k) =>
      selected.has(k),
    );
    for (const key of wsKeys) {
      transportParamsEntries.push(
        `        "${key}": lambda: FastAPIWebsocketParams(audio_in_enabled=True, audio_out_enabled=True${filterArg}),`,
      );
    }
  }

  // Runtime transfer adapter resolution
  const branches: string[] = [];
  const adapterImports = new Set<string>(["JevMenuProcessor", "SimulatedTransferAdapter"]);

  if (selected.has("twilio")) {
    runnerArgTypes.add("WebSocketRunnerArguments");
    adapterImports.add("TwilioTransferAdapter");
    branches.push(
      '    if isinstance(runner_args, WebSocketRunnerArguments) and getattr(runner_args, "transport_type", None) == "twilio":',
      '        call_data = getattr(runner_args, "call_data", None)',
      "        transfer_adapter = TwilioTransferAdapter(",
      "            transport=transport,",
      '            call_sid=getattr(call_data, "call_id", None) if call_data is not None else None,',
      "        )",
    );
  }
  if (selected.has("daily_pstn")) {
    runnerArgTypes.add("DailyRunnerArguments");
    adapterImports.add("DailySipTransferAdapter");
    const kw = branches.length > 0 ? "elif" : "if";
    branches.push(
      `    ${kw} isinstance(runner_args, DailyRunnerArguments):`,
      "        transfer_adapter = DailySipTransferAdapter()",
    );
  }
  if (selected.has("smallwebrtc") && branches.length > 0) {
    runnerArgTypes.add("SmallWebRTCRunnerArguments");
    branches.push(
      "    elif isinstance(runner_args, SmallWebRTCRunnerArguments):",
      "        transfer_adapter = SimulatedTransferAdapter()",
    );
  }

  if (branches.length > 0) {
    transferWiringLines.push(...branches, "    else:", "        transfer_adapter = SimulatedTransferAdapter()");
  } else {
    transferWiringLines.push("    transfer_adapter = SimulatedTransferAdapter()");
  }

  return {
    imports: [
      ...imports,
      `from pipecat.runner.types import ${Array.from(runnerArgTypes).join(", ")}`,
      `from pipecat_jev import ${Array.from(adapterImports).sort().join(", ")}`,
    ],
    transportParamsEntries,
    transferWiringLines,
  };
}

export function buildBotPy(
  graph: MenuGraph,
  config: PipecatExportConfig,
  menuFilename = "menu.json",
): string {
  const hybrid = graphUsesHandoffLlm(graph);
  const stt = STT_SERVICES.find((s) => s.id === config.stt) ?? STT_SERVICES[0];
  const tts = TTS_SERVICES.find((s) => s.id === config.tts) ?? TTS_SERVICES[0];
  const llm = LLM_SERVICES.find((s) => s.id === config.llm) ?? LLM_SERVICES[0];
  const selected = new Set<PipecatPlatformId>(
    config.platforms.length > 0 ? config.platforms : ["smallwebrtc"],
  );
  const needsCustomHookStub =
    collectTransferActions(graph).length > 0 &&
    Array.from(selected).some((id) => PLATFORM_MAP.get(id)?.requiresTransferHook);

  const transportSetup = buildTransportImportsAndParams(config);

  const lines: string[] = [
    '"""Deterministic Pipecat >=1.16 voice IVR bot powered by TypeSafe Jev."""',
    "",
    "from __future__ import annotations",
    "",
    "import os",
    "from pathlib import Path",
    "",
    "from dotenv import load_dotenv",
    "from loguru import logger",
    ...(config.enableKrisp
      ? ["from pipecat.audio.filters.krisp_viva_filter import KrispVivaFilter"]
      : []),
    "from pipecat.audio.vad.silero import SileroVADAnalyzer",
    "from pipecat.frames.frames import LLMRunFrame",
    "from pipecat.pipeline.pipeline import Pipeline",
    "from pipecat.pipeline.worker import PipelineParams, PipelineWorker",
    "from pipecat.processors.aggregators.llm_context import LLMContext",
    "from pipecat.processors.aggregators.llm_response_universal import (",
    "    LLMContextAggregatorPair,",
    "    LLMUserAggregatorParams,",
    ")",
    "from pipecat.runner.utils import create_transport",
    `from ${stt.importPath} import ${stt.className}`,
    `from ${tts.importPath} import ${tts.className}`,
    ...(hybrid ? [`from ${llm.importPath} import ${llm.className}`] : []),
    "from pipecat.transports.base_transport import BaseTransport",
    "from pipecat.workers.runner import WorkerRunner",
    ...transportSetup.imports,
    "",
    "load_dotenv(override=True)",
    `MENU_PATH = Path(__file__).with_name("${menuFilename}")`,
    "",
    "",
    "async def run_bot(transport: BaseTransport, runner_args: RunnerArguments) -> None:",
    `    stt = ${stt.initExpr}`,
    `    tts = ${tts.initExpr}`,
    ...(hybrid ? [`    llm = ${llm.initExpr}`] : []),
    "",
    "    context = LLMContext()",
    "    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(",
    "        context,",
    "        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),",
    "    )",
    "",
    ...transportSetup.transferWiringLines,
    "",
    "    ivr = JevMenuProcessor.from_file(",
    "        MENU_PATH,",
    '        api_key=os.environ["TYPESAFE_API_KEY"],',
    "        transfer_adapter=transfer_adapter,",
    "    )",
    "",
    ...(needsCustomHookStub
      ? [
          "    @ivr.on_transfer",
          "    async def handle_platform_transfer(ctx):",
          '        if ctx.mode in ("twilio_dial", "daily_sip_refer") and not isinstance(',
          "            transfer_adapter, SimulatedTransferAdapter",
          "        ):",
          "            await transfer_adapter.execute(ctx)",
          "            return",
          "        # TODO: Connect Telnyx/Plivo/Exotel/LiveKit/Vonage call transfer API here.",
          "        # See ctx.target, ctx.mode, ctx.extracted, and runner_args.call_data.",
          '        logger.warning(f"Custom transfer requested to {ctx.target!r} (mode={ctx.mode})")',
          "        await transfer_adapter.execute(ctx)",
          "",
        ]
      : []),
    "    pipeline = Pipeline(",
    "        [",
    "            transport.input(),",
    "            stt,",
    "            user_aggregator,",
    "            ivr,",
    ...(hybrid ? ["            llm,"] : []),
    "            tts,",
    "            transport.output(),",
    "            assistant_aggregator,",
    "        ]",
    "    )",
    "",
    `    worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=${config.enableMetrics ? "True" : "False"}))`,
    "",
    '    @transport.event_handler("on_client_connected")',
    "    async def on_client_connected(_transport, _client):",
    '        logger.info("Caller connected — triggering entry IVR greeting")',
    "        # LLMUserAggregator converts LLMRunFrame into a 0-user-turn LLMContextFrame,",
    "        # triggering JevMenuProcessor's entry greeting script.",
    "        await worker.queue_frames([LLMRunFrame()])",
    "",
    '    @transport.event_handler("on_client_disconnected")',
    "    async def on_client_disconnected(_transport, _client):",
    "        await worker.cancel()",
    "",
    "    runner = WorkerRunner(handle_sigint=False)",
    "    await runner.add_workers(worker)",
    "    await runner.run()",
    "",
    "",
    "async def bot(runner_args: RunnerArguments) -> None:",
    "    transport_params = {",
    ...transportSetup.transportParamsEntries,
    "    }",
    "    transport = await create_transport(runner_args, transport_params)",
    "    await run_bot(transport, runner_args)",
    "",
    "",
    'if __name__ == "__main__":',
    "    from pipecat.runner.run import main",
    "",
    "    main()",
    "",
  ];

  return lines.join("\n");
}

function buildPyprojectToml(graph: MenuGraph, config: PipecatExportConfig): string {
  const hybrid = graphUsesHandoffLlm(graph);
  const stt = STT_SERVICES.find((s) => s.id === config.stt) ?? STT_SERVICES[0];
  const tts = TTS_SERVICES.find((s) => s.id === config.tts) ?? TTS_SERVICES[0];
  const llm = LLM_SERVICES.find((s) => s.id === config.llm) ?? LLM_SERVICES[0];

  const extras = new Set<string>(["runner", "silero", stt.extra, tts.extra]);
  if (hybrid) extras.add(llm.extra);
  for (const id of config.platforms) {
    const spec = PLATFORM_MAP.get(id);
    if (spec) extras.add(spec.extra);
  }
  const sortedExtras = Array.from(extras).sort().join(",");
  const pkgName = sanitizeAgentSlug(config.agentName || graph.id || "voice_ivr");

  return [
    "[project]",
    `name = "${pkgName}"`,
    'version = "0.1.0"',
    `description = ${JSON.stringify(`Deterministic Pipecat voice IVR for ${graph.name || graph.id}`)}`,
    'requires-python = ">=3.11,<3.14"',
    "dependencies = [",
    `  "pipecat-ai[${sortedExtras}]>=1.16.0,<2.0.0",`,
    '  "pipecat-jev>=0.2.0",',
    '  "python-dotenv>=1.0.0",',
    "]",
    "",
  ].join("\n");
}

function buildEnvExample(graph: MenuGraph, config: PipecatExportConfig): string {
  const hybrid = graphUsesHandoffLlm(graph);
  const stt = STT_SERVICES.find((s) => s.id === config.stt) ?? STT_SERVICES[0];
  const tts = TTS_SERVICES.find((s) => s.id === config.tts) ?? TTS_SERVICES[0];
  const llm = LLM_SERVICES.find((s) => s.id === config.llm) ?? LLM_SERVICES[0];

  const entries: { key: string; comment: string; placeholder?: string }[] = [
    { key: "TYPESAFE_API_KEY", comment: "TypeSafe Jev API key (https://docs.typesafe.ai/api/system-one)" },
    ...stt.envVars,
    ...tts.envVars,
    ...(hybrid ? llm.envVars : []),
  ];

  for (const id of config.platforms) {
    const spec = PLATFORM_MAP.get(id);
    if (spec) entries.push(...spec.envVars);
  }

  if (config.enableKrisp) {
    entries.push(
      { key: "KRISP_VIVA_API_KEY", comment: "Krisp VIVA SDK API key (required for KrispVivaFilter)" },
      {
        key: "KRISP_VIVA_FILTER_MODEL_PATH",
        comment: "Path to Krisp .kef noise cancellation model (managed automatically on Pipecat Cloud when enable_krisp = true)",
      },
    );
  }

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    lines.push(`# ${entry.comment}`);
    lines.push(`${entry.key}=${entry.placeholder ?? ""}`);
    lines.push("");
  }
  return lines.join("\n");
}

function buildDockerfile(): string {
  return [
    "FROM dailyco/pipecat-base:latest",
    "",
    "# Enable bytecode compilation and install from uv.lock",
    "ENV UV_COMPILE_BYTECODE=1",
    "ENV UV_LINK_MODE=copy",
    "",
    "WORKDIR /app",
    "COPY pyproject.toml uv.lock* ./",
    "RUN uv sync --no-install-project --no-dev",
    "",
    "COPY bot.py menu.json ./",
    "",
    'CMD ["uv", "run", "bot.py"]',
    "",
  ].join("\n");
}

function buildPccDeployToml(graph: MenuGraph, config: PipecatExportConfig): string {
  const agentName = sanitizeAgentSlug(config.agentName || graph.id || "voice-ivr");
  const secretSet = sanitizeAgentSlug(config.secretSet || `${agentName}-secrets`);
  const image = config.image.trim() || `your-dockerhub-user/${agentName}:0.1`;

  return [
    `agent_name = "${agentName}"`,
    `image = "${image}"`,
    `secret_set = "${secretSet}"`,
    ...(config.enableKrisp ? ["enable_krisp = true"] : []),
    "",
    "[scaling]",
    "min_agents = 0",
    "",
  ].join("\n");
}

function buildBundleReadme(graph: MenuGraph, config: PipecatExportConfig): string {
  const selected = config.platforms.length > 0 ? config.platforms : (["smallwebrtc"] as PipecatPlatformId[]);
  const platformLabels = selected.map((id) => PLATFORM_MAP.get(id)?.label ?? id).join(", ");
  const runExamples = selected
    .map((id) => {
      const key = PLATFORM_MAP.get(id)?.transportKey ?? "webrtc";
      if (key === "twilio" || key === "telnyx" || key === "plivo") {
        return `- ${PLATFORM_MAP.get(id)?.label}: \`uv run bot.py -t ${key} -x <your-ngrok-host>\``;
      }
      return `- ${PLATFORM_MAP.get(id)?.label}: \`uv run bot.py -t ${key}\``;
    })
    .join("\n");

  const lines = [
    `# ${graph.name || graph.id} — Pipecat Deterministic IVR`,
    "",
    `Configured platforms: **${platformLabels}**`,
    "",
    "## 1. Setup",
    "",
    "```bash",
    "cp .env.example .env",
    "# Fill in TYPESAFE_API_KEY and your selected provider keys in .env",
    "uv sync",
    "```",
    "",
    "## 2. Validate & Eval Menu",
    "",
    "```bash",
    "uv run jev-ivr validate menu.json --json",
    "uv run jev-ivr eval menu.json --split tune --json",
    "```",
    "",
    "## 3. Run Locally",
    "",
    runExamples,
    "",
  ];

  if (config.deployTarget === "pipecat_cloud") {
    const secretSet = sanitizeAgentSlug(config.secretSet || `${config.agentName || graph.id}-secrets`);
    lines.push(
      "## 4. Deploy to Pipecat Cloud",
      "",
      "```bash",
      "uv lock",
      `pipecat cloud secrets set ${secretSet} --file .env --skip`,
      "pipecat cloud deploy --force",
      "```",
      "",
    );
  }

  return lines.join("\n");
}

export function buildPipecatBundle(graph: MenuGraph, config: PipecatExportConfig): PipecatBundleFile[] {
  const verified = parseMenuGraph(graph);
  const files: PipecatBundleFile[] = [
    { path: "bot.py", language: "python", content: buildBotPy(verified, config, "menu.json") },
    { path: "menu.json", language: "json", content: `${JSON.stringify(verified, null, 2)}\n` },
    { path: "pyproject.toml", language: "toml", content: buildPyprojectToml(verified, config) },
    { path: ".env.example", language: "env", content: buildEnvExample(verified, config) },
    { path: "README.md", language: "markdown", content: buildBundleReadme(verified, config) },
  ];

  if (config.deployTarget === "pipecat_cloud") {
    files.push(
      { path: "pcc-deploy.toml", language: "toml", content: buildPccDeployToml(verified, config) },
      { path: "Dockerfile", language: "dockerfile", content: buildDockerfile() },
    );
  }

  return files;
}

// --- Zero-dependency uncompressed (STORE) ZIP builder ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function createZipArchive(files: { path: string; content: string }[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const dataBytes = encoder.encode(file.content);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true); // Version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lv.setUint16(8, 0, true); // Compression method: 0 (STORE)
    lv.setUint16(10, 0, true); // Mod time
    lv.setUint16(12, 0x5421, true); // Mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // Extra field length
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central directory header signature
    cv.setUint16(4, 20, true); // Version made by
    cv.setUint16(6, 20, true); // Version needed
    cv.setUint16(8, 0x0800, true); // UTF-8 flag
    cv.setUint16(10, 0, true); // Method: STORE
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x5421, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // End of central directory signature
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalLength = offset + centralSize + eocd.length;
  const archive = new Uint8Array(new ArrayBuffer(totalLength));
  let cursor = 0;
  for (const part of localParts) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  for (const part of centralParts) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  archive.set(eocd, cursor);
  return archive;
}
