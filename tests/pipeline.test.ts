import assert from "node:assert/strict";
import test from "node:test";
import { answerTurn } from "../lib/answer";
import { buildAssistant } from "../lib/assistant";
import { followPlace, presentDeeper, presentMenu, readMenu, reprompt, systemMessage, type Menu } from "../lib/menu";

const menu: Menu = {
  name: "Northwind",
  script: "",
  options: [
    { id: "billing", title: "Billing", hints: "A charge or refund", reply: "I'll connect you with billing." },
    { id: "support", title: "Support", hints: "Something is broken", reply: "I'll connect you with support." },
  ],
};

const menuWithScript: Menu = {
  ...menu,
  script: presentMenu(menu.name, menu.options),
};

test("the spoken menu names every option", () => {
  assert.equal(
    presentMenu("Northwind", menu.options),
    "Thanks for calling Northwind. You can say Billing or Support.",
  );
});

test("the Vapi module is Flux, then Jev, then Deepgram speech", () => {
  const assistant = buildAssistant(menu, "https://example.com/api/vapi/chat/completions/");
  assert.equal(assistant.transcriber.model, "flux-general-en");
  assert.equal(assistant.model.provider, "custom-llm");
  assert.equal(assistant.model.model, "jev");
  assert.equal(assistant.model.url, "https://example.com/api/vapi");
  assert.equal(assistant.voice.provider, "deepgram");
  assert.equal(assistant.voice.voiceId, "asteria");
  assert.equal(assistant.voice.model, "aura-2");
  assert.deepEqual(assistant.metadata.pipeline, ["deepgram-flux", "jev", "deepgram-tts"]);
});

test("a fifty-character menu name is sliced to forty characters", () => {
  const name = "N".repeat(50);
  const assistant = buildAssistant(
    { ...menu, name },
    "https://example.com/api/vapi/chat/completions/",
  );
  assert.equal(assistant.name, name.slice(0, 40));
});

test("the system message keeps each option reply", () => {
  const stored = readMenu(systemMessage(menu));
  assert.ok(stored);
  assert.deepEqual(
    stored.options.map((option) => option.reply),
    menu.options.map((option) => option.reply),
  );
});

test("a billing choice speaks the stored reply", async () => {
  const result = await answerTurn({
    body: {
      messages: [
        { role: "system", content: systemMessage(menuWithScript) },
        { role: "user", content: "I was charged twice" },
      ],
    },
    jevKey: "test",
    fetchImpl: async () =>
      Response.json({
        answers: {
          option: {
            type: "choice",
            choice: "billing",
            confidence: 0.91,
          },
        },
      }),
  });
  assert.equal(result.stage, "jev");
  assert.equal(result.content, "I'll connect you with billing.");
});

test("an unclear choice speaks the menu reprompt", async () => {
  const result = await answerTurn({
    body: {
      messages: [
        { role: "system", content: systemMessage(menuWithScript) },
        { role: "user", content: "I am not sure what I need" },
      ],
    },
    jevKey: "test",
    fetchImpl: async () =>
      Response.json({
        answers: {
          option: {
            type: "choice",
            choice: "unclear",
            confidence: 0.2,
          },
        },
      }),
  });
  assert.equal(result.stage, "jev");
  assert.equal(result.content, reprompt(menu.options));
});

const billingMenu: Menu = {
  name: "Billing",
  script: "Billing. You can say Invoice or Refund.",
  options: [
    { id: "invoice", title: "Invoice", hints: "A bill or a charge", reply: "I'll pull up invoices." },
    { id: "refund", title: "Refund", hints: "Money back", reply: "I'll start a refund." },
  ],
};

const nested: Menu = {
  ...menuWithScript,
  options: [
    { ...menuWithScript.options[0], menu: billingMenu },
    menuWithScript.options[1],
  ],
};

test("a deeper menu speaks its own script", () => {
  assert.equal(presentDeeper("Billing", billingMenu.options), billingMenu.script);
});

test("choosing a menu moves the call into it", async () => {
  let sawDeeper = false;
  const entered = await answerTurn({
    body: {
      messages: [
        { role: "system", content: systemMessage(nested) },
        { role: "assistant", content: nested.script },
        { role: "user", content: "I was charged twice" },
      ],
    },
    jevKey: "test",
    fetchImpl: async () => Response.json({
      answers: { option: { type: "choice", choice: "billing", confidence: 0.91 } },
    }),
  });
  assert.equal(entered.content, billingMenu.script);
  assert.equal(entered.place, "Northwind / Billing");

  const inside = await answerTurn({
    body: {
      messages: [
        { role: "system", content: systemMessage(nested) },
        { role: "assistant", content: nested.script },
        { role: "user", content: "I was charged twice" },
        { role: "assistant", content: billingMenu.script },
        { role: "user", content: "I want my money back" },
      ],
    },
    jevKey: "test",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      sawDeeper = "refund" in body.questions.option.criteria && !("support" in body.questions.option.criteria);
      return Response.json({
        answers: { option: { type: "choice", choice: "refund", confidence: 0.88 } },
      });
    },
  });
  assert.equal(sawDeeper, true);
  assert.equal(inside.content, "I'll start a refund.");
  assert.equal(inside.place, "Northwind / Billing");
});

test("a call can start already inside a deeper menu", () => {
  const started = { ...nested, start: ["billing"] };
  const assistant = buildAssistant(started, "https://example.com/api/vapi");
  assert.equal(assistant.firstMessage, billingMenu.script);
  assert.deepEqual(readMenu(assistant.model.messages[0].content)?.start, ["billing"]);
  assert.equal(followPlace(started, []).label, "Northwind / Billing");
});
