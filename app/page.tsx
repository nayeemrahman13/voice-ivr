"use client";

import { buildAssistant } from "@/lib/assistant";
import { presentDeeper, presentMenu, slugify, type Menu, type MenuOption, withUniqueIds } from "@/lib/menu";
import { useEffect, useRef, useState } from "react";

type DraftOption = { key: string; title: string; hints: string; reply: string; menu: DraftMenu | null };
type DraftMenu = { name: string; script: string; scriptTouched: boolean; options: DraftOption[] };
type Status = { jev: boolean; deepgram: boolean; vapi: boolean };
type Result = { content: string; stage: "jev"; path: "text" | "audio"; transcript: string; place?: string };
type Place = { keys: string[]; label: string };

const starters: DraftOption[] = [
  { key: "billing", title: "Billing", hints: "A charge, invoice, payment, or refund", reply: "I'll connect you with billing.", menu: null },
  { key: "support", title: "Support", hints: "Something is broken or they need help using the product", reply: "I'll connect you with support.", menu: null },
  { key: "sales", title: "Sales", hints: "Pricing, a new account, or a demo", reply: "I'll connect you with sales.", menu: null },
];

export default function Page() {
  const [root, setRoot] = useState<DraftMenu>({
    name: "Northwind",
    script: presentMenu("Northwind", starters),
    scriptTouched: false,
    options: starters,
  });
  const [focus, setFocus] = useState<string[]>([]);
  const [start, setStart] = useState<string[]>([]);
  const [llmUrl, setLlmUrl] = useState("");
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [audio, setAudio] = useState<{ blob: Blob; url: string } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [created, setCreated] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    setLlmUrl(`${window.location.origin}/api/vapi`);
    fetch("/api/status").then((response) => response.json()).then(setStatus).catch(() => undefined);
  }, []);

  const menuDraft = menuByPath(root, focus);
  const trail = crumbs(root, focus);
  const levels = places(root);

  function menu(): Menu {
    const built = convertMenu(root, true);
    const ids = startIds(root, start);
    return ids.length ? { ...built, start: ids } : built;
  }

  function edit(path: string[], update: (menu: DraftMenu) => DraftMenu) {
    setRoot((current) => mapMenu(current, path, (menu) => rewriteScript(update(menu), path.length === 0)));
  }

  function updateOption(key: string, patch: Partial<DraftOption>) {
    edit(focus, (menu) => ({
      ...menu,
      options: menu.options.map((option) => (option.key === key ? { ...option, ...patch } : option)),
    }));
  }

  async function toggleRecording() {
    if (recorder.current?.state === "recording") {
      recorder.current.stop();
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const media = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    media.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    media.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: media.mimeType || "audio/webm" });
      setAudio((current) => {
        if (current) URL.revokeObjectURL(current.url);
        return { blob, url: URL.createObjectURL(blob) };
      });
      setRecording(false);
    };
    media.start();
    recorder.current = media;
    setRecording(true);
  }

  async function tryReply() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const current = menu();
      if (menuByPath(root, start).options.filter((option) => option.title.trim()).length < 2) {
        throw new Error("Add at least two options to this menu.");
      }
      const payload: Record<string, unknown> = { menu: current, text };
      if (audio && !text.trim()) {
        payload.audioBase64 = await blobToBase64(audio.blob);
        payload.mimeType = audio.blob.type;
      }
      const response = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "The try failed.");
      setResult(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The try failed.");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const current = menu();
    const assistant = buildAssistant(current, llmUrl);
    const file = new Blob([JSON.stringify(assistant, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slugify(current.name) || "ivr"}.vapi.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function createInVapi() {
    setBusy(true);
    setError("");
    setCreated("");
    try {
      const response = await fetch("/api/vapi/assistants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildAssistant(menu(), llmUrl)),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Vapi did not create the assistant.");
      setCreated(body.dashboardUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Vapi did not create the assistant.");
    } finally {
      setBusy(false);
    }
  }

  const missing = [
    status && !status.deepgram ? "Deepgram key" : "",
    status && !status.jev ? "TypeSafe key" : "",
    status && !status.vapi ? "Vapi key" : "",
  ].filter(Boolean);

  return (
    <main>
      <header>
        <p className="kicker">Vapi assistant</p>
        <h1>Phone menu</h1>
        <p className="lead">
          List the options and write the line the agent says for each one. An option can open a nested menu, and you choose which menu the call is in. Flux listens, Jev picks the stored line for that menu, and Deepgram speaks it.
        </p>
        <ol className="pipeline">
          <li>Flux</li>
          <li>Jev</li>
          <li>Speech</li>
        </ol>
        {missing.length > 0 && (
          <p className="banner">Add {missing.join(", ")} to .env.local and restart. The names are DEEPGRAM_API_KEY, TYPESAFE_API_KEY, and VAPI_API_KEY.</p>
        )}
      </header>
      <div className="grid">
        <section>
          <h2>Options</h2>
          <div className="row crumbs">
            {trail.map((crumb, index) => (
              <button className="secondary" type="button" key={crumb.keys.join("/") || "root"} onClick={() => setFocus(crumb.keys)}>
                {index === 0 ? crumb.label : `/ ${crumb.label}`}
              </button>
            ))}
          </div>
          <label>
            {focus.length === 0 ? "Menu name" : "Nested menu name"}
            <input value={menuDraft.name} onChange={(event) => edit(focus, (menu) => ({ ...menu, name: event.target.value }))} />
          </label>
          {menuDraft.options.map((option) => (
            <div className="option" key={option.key}>
              <label>
                Option
                <input value={option.title} onChange={(event) => updateOption(option.key, { title: event.target.value })} />
              </label>
              <label>
                What the caller might say
                <input value={option.hints} onChange={(event) => updateOption(option.key, { hints: event.target.value })} />
              </label>
              {option.menu ? (
                <p className="hint">Jev opens this nested menu and says its script.</p>
              ) : (
                <label>
                  What the agent says after Jev picks it
                  <input value={option.reply} onChange={(event) => updateOption(option.key, { reply: event.target.value })} />
                </label>
              )}
              <div className="row">
                {option.menu ? (
                  <>
                    <button className="secondary" type="button" onClick={() => setFocus([...focus, option.key])}>Edit nested menu</button>
                    <button className="secondary" type="button" onClick={() => {
                      updateOption(option.key, { menu: null });
                      setStart((current) => trimStart(current, [...focus, option.key]));
                    }}>Remove nested menu</button>
                  </>
                ) : (
                  <button className="secondary" type="button" onClick={() => {
                    const deeper: DraftMenu = {
                      name: option.title.trim() || "Menu",
                      script: presentDeeper(option.title.trim() || "Menu", []),
                      scriptTouched: false,
                      options: [
                        { key: crypto.randomUUID(), title: "", hints: "", reply: "", menu: null },
                        { key: crypto.randomUUID(), title: "", hints: "", reply: "", menu: null },
                      ],
                    };
                    updateOption(option.key, { menu: deeper });
                    setFocus([...focus, option.key]);
                  }}>Nested menu</button>
                )}
                <button className="secondary" type="button" onClick={() => {
                  edit(focus, (menu) => ({ ...menu, options: menu.options.filter((item) => item.key !== option.key) }));
                  setStart((current) => trimStart(current, [...focus, option.key]));
                }}>Remove</button>
              </div>
            </div>
          ))}
          <div className="row">
            <button className="secondary" type="button" onClick={() => {
              edit(focus, (menu) => ({
                ...menu,
                options: [...menu.options, { key: crypto.randomUUID(), title: "", hints: "", reply: "", menu: null }],
              }));
            }}>Add option</button>
          </div>
          <h2 style={{ marginTop: 22 }}>Spoken menu</h2>
          <textarea
            value={menuDraft.script}
            onChange={(event) => edit(focus, (menu) => ({ ...menu, script: event.target.value, scriptTouched: true }))}
          />
          {menuDraft.scriptTouched && (
            <button className="secondary" type="button" onClick={() => {
              edit(focus, (menu) => ({ ...menu, scriptTouched: false }));
            }}>Rewrite from the options</button>
          )}
        </section>
        <section>
          <h2>Try a reply</h2>
          <label>
            Conversation is in
            <select
              value={start.join("/")}
              onChange={(event) => setStart(event.target.value ? event.target.value.split("/") : [])}
            >
              {levels.map((level) => (
                <option key={level.keys.join("/") || "root"} value={level.keys.join("/")}>{level.label}</option>
              ))}
            </select>
          </label>
          <label>
            Typed reply
            <input value={text} placeholder="I was charged twice" onChange={(event) => setText(event.target.value)} />
          </label>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="secondary" type="button" onClick={() => void toggleRecording()}>
              {recording ? "Stop" : "Record"}
            </button>
            {recording && <span className="recording">Listening</span>}
            {audio && <button className="secondary" type="button" onClick={() => {
              URL.revokeObjectURL(audio.url);
              setAudio(null);
            }}>Clear recording</button>}
          </div>
          {audio && <audio src={audio.url} controls />}
          <p className="hint">A typed reply is used as-is, a recording is transcribed, and on a phone call Flux produces the transcript before Jev picks the stored line.</p>
          <div className="row">
            <button type="button" disabled={busy} onClick={() => void tryReply()}>{busy ? "Working" : "Run the turn"}</button>
          </div>
          {error && <p className="banner">{error}</p>}
          {result && (
            <div className="result">
              <strong>{result.content}</strong>
              <p className="hint">
                Jev chose this stored line{result.place ? `. The call is now in ${result.place}` : ""}. Heard from the {result.path === "audio" ? "recording" : "typed reply"}: {result.transcript}
              </p>
            </div>
          )}
          <h2 style={{ marginTop: 22 }}>Vapi module</h2>
          <label>
            Custom LLM base URL
            <input value={llmUrl} onChange={(event) => setLlmUrl(event.target.value)} />
          </label>
          <p className="hint">Vapi calls {llmUrl || "this server"}/chat/completions. A local address works for this page. A live call needs a public URL.</p>
          <div className="row">
            <button type="button" onClick={download}>Download assistant</button>
            <button className="secondary" type="button" disabled={busy || !status?.vapi} onClick={() => void createInVapi()}>Create in Vapi</button>
          </div>
          {created && <p className="hint"><a href={created}>{created}</a></p>}
        </section>
      </div>
    </main>
  );
}

function mapMenu(menu: DraftMenu, path: string[], update: (menu: DraftMenu) => DraftMenu): DraftMenu {
  if (path.length === 0) return update(menu);
  const [key, ...rest] = path;
  return {
    ...menu,
    options: menu.options.map((option) => (
      option.key === key && option.menu ? { ...option, menu: mapMenu(option.menu, rest, update) } : option
    )),
  };
}

function menuByPath(menu: DraftMenu, path: string[]): DraftMenu {
  let node = menu;
  for (const key of path) {
    const next = node.options.find((option) => option.key === key)?.menu;
    if (!next) return node;
    node = next;
  }
  return node;
}

function rewriteScript(menu: DraftMenu, rootLevel: boolean): DraftMenu {
  if (menu.scriptTouched) return menu;
  const titled = menu.options.filter((option) => option.title.trim());
  return { ...menu, script: rootLevel ? presentMenu(menu.name, titled) : presentDeeper(menu.name, titled) };
}

function convertMenu(draft: DraftMenu, rootLevel: boolean): Menu {
  const options = withUniqueIds(draft.options.filter((option) => option.title.trim()).map((option) => {
    const nested = option.menu ? convertMenu(option.menu, false) : undefined;
    return {
      id: slugify(option.title),
      title: option.title.trim(),
      hints: option.hints.trim(),
      reply: option.reply.trim(),
      ...(nested && nested.options.length > 0 ? { menu: nested } : {}),
    } satisfies MenuOption;
  }));
  return {
    name: draft.name.trim(),
    script: draft.script.trim() || (rootLevel ? presentMenu(draft.name, options) : presentDeeper(draft.name, options)),
    options,
  };
}

function startIds(draft: DraftMenu, keys: string[]): string[] {
  const ids: string[] = [];
  let node = draft;
  for (const key of keys) {
    const visible = node.options.filter((option) => option.title.trim());
    const unique = withUniqueIds(visible.map((option) => ({
      id: slugify(option.title),
      title: option.title.trim(),
      hints: option.hints.trim(),
      reply: option.reply.trim(),
    })));
    const index = visible.findIndex((option) => option.key === key);
    if (index < 0 || !visible[index].menu) break;
    ids.push(unique[index].id);
    node = visible[index].menu;
  }
  return ids;
}

function places(draft: DraftMenu, keys: string[] = [], label = ""): Place[] {
  const here = label || draft.name.trim() || "Main menu";
  const list: Place[] = [{ keys, label: here }];
  for (const option of draft.options) {
    if (!option.menu || !option.title.trim()) continue;
    list.push(...places(option.menu, [...keys, option.key], `${here} / ${option.title.trim()}`));
  }
  return list;
}

function crumbs(draft: DraftMenu, path: string[]): Place[] {
  const list: Place[] = [{ keys: [], label: draft.name.trim() || "Main menu" }];
  let node = draft;
  const keys: string[] = [];
  for (const key of path) {
    const option = node.options.find((item) => item.key === key);
    if (!option?.menu) break;
    keys.push(key);
    list.push({ keys: [...keys], label: option.menu.name.trim() || option.title.trim() || "Menu" });
    node = option.menu;
  }
  return list;
}

function trimStart(start: string[], removed: string[]): string[] {
  const matches = removed.every((key, index) => start[index] === key);
  return matches ? removed.slice(0, -1) : start;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result);
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
