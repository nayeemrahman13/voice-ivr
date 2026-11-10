import { menuAt, type Menu, parseMenu, systemMessage } from "./menu";

export type AssistantModule = {
  name: string;
  firstMessage: string;
  firstMessageMode: "assistant-speaks-first";
  backgroundSound: "off";
  transcriber: {
    provider: "deepgram";
    model: "flux-general-en";
    language: "en";
    eotThreshold: number;
  };
  voice: {
    provider: "deepgram";
    voiceId: "asteria";
    model: "aura-2";
  };
  model: {
    provider: "custom-llm";
    url: string;
    model: "jev";
    temperature: number;
    maxTokens: number;
    metadataSendMode: "variable";
    messages: { role: "system"; content: string }[];
  };
  metadata: {
    ivr: Menu;
    pipeline: ["deepgram-flux", "jev", "deepgram-tts"];
  };
};

export function normalizeCustomLlmUrl(input: string): string {
  return input.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

export function buildAssistant(menuInput: Menu, customLlmUrl: string): AssistantModule {
  const menu = parseMenu(menuInput);
  const url = normalizeCustomLlmUrl(customLlmUrl);
  if (!url) {
    throw new Error("Add the custom LLM base URL.");
  }

  return {
    name: (menu.name || "IVR").slice(0, 40),
    firstMessage: menuAt(menu, menu.start ?? []).script,
    firstMessageMode: "assistant-speaks-first",
    backgroundSound: "off",
    transcriber: {
      provider: "deepgram",
      model: "flux-general-en",
      language: "en",
      eotThreshold: 0.7,
    },
    voice: {
      provider: "deepgram",
      voiceId: "asteria",
      model: "aura-2",
    },
    model: {
      provider: "custom-llm",
      url,
      model: "jev",
      temperature: 0,
      maxTokens: 200,
      metadataSendMode: "variable",
      messages: [{ role: "system", content: systemMessage(menu) }],
    },
    metadata: {
      ivr: menu,
      pipeline: ["deepgram-flux", "jev", "deepgram-tts"],
    },
  };
}
