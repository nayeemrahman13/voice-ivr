"use client";

import type { Decision } from "@/lib/decide";
import type { Turn } from "@/lib/jev";
import {
  cloneRecord,
  hasOwn,
  presentDeeper,
  presentMenu,
  setOwn,
  validateMenuGraph,
  VALID_DTMF,
  type DtmfKey,
  type MenuAction,
  type MenuGraph,
} from "@/lib/menu";
import {
  addNodeOption,
  addSubmenuNode,
  buildPipecatSnippet,
  createStarterGraph,
  exportMenuJson,
  importMenuJson,
  removeNodeOption,
  updateNodeFields,
  updateNodeOption,
} from "@/lib/studio";
import { useEffect, useRef, useState } from "react";

type Status = { jev: boolean; deepgram: boolean };

const DTMF_CHOICES = ["", ...Array.from(VALID_DTMF)];

export default function Page() {
  const [graph, setGraph] = useState<MenuGraph>(() => createStarterGraph());
  const [selectedNodeId, setSelectedNodeId] = useState<string>("main");
  const [touchedScripts, setTouchedScripts] = useState<Record<string, boolean>>({});

  // Multi-turn Playground session state
  const [simNodeId, setSimNodeId] = useState<string>("main");
  const [simStack, setSimStack] = useState<string[]>([]);
  const [simStreak, setSimStreak] = useState<number>(0);
  const [simExtracted, setSimExtracted] = useState<Record<string, boolean | string>>({});
  const [simHistory, setSimHistory] = useState<Turn[]>([]);

  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [audio, setAudio] = useState<{ blob: Blob; url: string } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Decision | null>(null);
  const [copied, setCopied] = useState(false);

  const recorder = useRef<MediaRecorder | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((res) => res.json())
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  const nodeIds = Object.keys(graph.nodes);
  const activeEditId = hasOwn(graph.nodes, selectedNodeId) ? selectedNodeId : graph.entry;
  const activeNode = graph.nodes[activeEditId];
  const validation = validateMenuGraph(graph);

  function resetSimSession(targetNode = graph.entry, nextGraph = graph) {
    const startStack = targetNode === nextGraph.entry ? nextGraph.initialStack ?? [] : [];
    const opening = nextGraph.nodes[targetNode]?.script ?? "";
    setSimNodeId(targetNode);
    setSimStack(startStack);
    setSimStreak(0);
    setSimExtracted({});
    setSimHistory(opening ? [{ role: "assistant", text: opening }] : []);
    setResult(null);
    setError("");
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

  async function runTurn() {
    setBusy(true);
    setError("");
    try {
      const currentNode = hasOwn(graph.nodes, simNodeId) ? simNodeId : graph.entry;
      const baseHistory =
        simHistory.length > 0
          ? simHistory
          : [{ role: "assistant" as const, text: graph.nodes[currentNode]?.script ?? "" }];

      const payload: Record<string, unknown> = {
        menu: graph,
        nodeId: currentNode,
        stack: simStack,
        unclearStreak: simStreak,
        extracted: simExtracted,
        history: baseHistory,
        text,
      };
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
      if (!response.ok) throw new Error(body.error || "Turn evaluation failed.");

      const decision = body as Decision;
      setResult(decision);
      setSimNodeId(decision.nextNodeId);
      setSimStack(decision.nextStack);
      setSimStreak(decision.nextUnclearStreak);
      setSimExtracted(decision.extracted);
      setSimHistory([
        ...baseHistory,
        { role: "user", text: decision.transcript },
        ...(decision.spokenReply ? [{ role: "assistant" as const, text: decision.spokenReply }] : []),
      ]);
      setText("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Turn evaluation failed.");
    } finally {
      setBusy(false);
    }
  }

  function handleDownloadMenu() {
    setError("");
    try {
      const serialized = exportMenuJson(graph);
      const file = new Blob([serialized], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${graph.id || "ivr"}.menu.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not export menu.json.");
    }
  }

  async function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    try {
      const raw = await file.text();
      const imported = importMenuJson(raw);
      const touched: Record<string, boolean> = {};
      for (const id of Object.keys(imported.nodes)) setOwn(touched, id, true);
      setGraph(imported);
      setTouchedScripts(touched);
      setSelectedNodeId(imported.entry);
      resetSimSession(imported.entry, imported);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not import menu JSON.");
    }
  }

  function handleActionTypeChange(optionId: string, actionType: MenuAction["type"]) {
    let action: MenuAction;
    switch (actionType) {
      case "goto": {
        const fallbackTarget = nodeIds.find((n) => n !== activeEditId) ?? activeEditId;
        action = { type: "goto", target: fallbackTarget };
        break;
      }
      case "transfer":
        action = { type: "transfer", target: "+18005550100", mode: "twilio_dial" };
        break;
      case "webhook":
        action = {
          type: "webhook",
          url: "https://example.com/api/ivr-hook",
          method: "POST",
          next: { type: "end_call" },
        };
        break;
      case "handoff_llm":
        action = { type: "handoff_llm", systemPrompt: "Help the caller with their request concisely." };
        break;
      case "reply_only":
        action = { type: "reply_only" };
        break;
      case "end_call":
      default:
        action = { type: "end_call" };
        break;
    }
    setGraph((curr) => updateNodeOption(curr, activeEditId, optionId, { action }));
  }

  const missing = [
    status && !status.jev ? "TYPESAFE_API_KEY" : "",
    status && !status.deepgram ? "DEEPGRAM_API_KEY" : "",
  ].filter(Boolean);

  const snippet = buildPipecatSnippet(graph);

  return (
    <main>
      <header>
        <p className="kicker">Pipecat + TypeSafe Jev</p>
        <h1>Deterministic IVR Studio</h1>
        <p className="lead">
          Author a canonical v2 <span className="mono">.menu.json</span> graph, inspect Jev choice probabilities across multi-turn paths, and drop the file straight into <span className="mono">JevMenuProcessor</span> in any Pipecat pipeline.
        </p>
        <ol className="pipeline">
          <li>Deepgram STT / DTMF</li>
          <li>JevMenuProcessor (v2 Graph)</li>
          <li>Verbatim TTS or LLM Handoff</li>
        </ol>
        {missing.length > 0 && (
          <p className="banner">
            Add {missing.join(" and ")} to <span className="mono">.env.local</span> and restart to run live turns on this page.
          </p>
        )}
      </header>

      <div className="grid">
        <section>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2>Graph Nodes ({nodeIds.length})</h2>
            <div className="row">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => void handleImportFile(e)}
              />
              <button className="secondary" type="button" onClick={() => fileInputRef.current?.click()}>
                Import .menu.json
              </button>
              <button type="button" onClick={handleDownloadMenu}>
                Download .menu.json
              </button>
            </div>
          </div>

          <div className="row">
            {nodeIds.map((id) => (
              <button
                key={id}
                type="button"
                className={id === activeEditId ? "active-node" : "secondary"}
                onClick={() => setSelectedNodeId(id)}
              >
                {graph.nodes[id].name || id} {id === graph.entry ? "(entry)" : ""}
              </button>
            ))}
          </div>

          {activeNode && (
            <>
              <div className="two-col">
                <label>
                  Node title
                  <input
                    value={activeNode.name}
                    onChange={(e) =>
                      setGraph((curr) =>
                        updateNodeFields(curr, activeEditId, { name: e.target.value }, !touchedScripts[activeEditId]),
                      )
                    }
                  />
                </label>
                <label>
                  Node ID
                  <input value={activeNode.id} disabled className="mono" />
                </label>
              </div>

              {activeNode.options.map((option) => (
                <div className="option" key={option.id}>
                  <div className="option-head">
                    <span className="mono">id: {option.id}</span>
                    {activeNode.options.length > 1 && (
                      <button
                        className="secondary"
                        type="button"
                        style={{ padding: "4px 10px", fontSize: 12 }}
                        onClick={() => setGraph((curr) => removeNodeOption(curr, activeEditId, option.id))}
                      >
                        Remove
                      </button>
                    )}
                  </div>

                  <div className="two-col">
                    <label>
                      Option label (preserves ID)
                      <input
                        value={option.title}
                        onChange={(e) =>
                          setGraph((curr) =>
                            updateNodeOption(
                              curr,
                              activeEditId,
                              option.id,
                              { title: e.target.value },
                              !touchedScripts[activeEditId],
                            ),
                          )
                        }
                      />
                    </label>
                    <label>
                      DTMF key
                      <select
                        value={option.dtmf ?? ""}
                        onChange={(e) =>
                          setGraph((curr) =>
                            updateNodeOption(curr, activeEditId, option.id, {
                              dtmf: (e.target.value || undefined) as DtmfKey | undefined,
                            }),
                          )
                        }
                      >
                        {DTMF_CHOICES.map((k) => (
                          <option key={k || "none"} value={k}>
                            {k || "None"}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <label>
                    Contrastive Jev hints (what callers say)
                    <input
                      value={option.hints}
                      onChange={(e) =>
                        setGraph((curr) => updateNodeOption(curr, activeEditId, option.id, { hints: e.target.value }))
                      }
                    />
                  </label>

                  <div className="two-col">
                    <label>
                      Action type
                      <select
                        value={option.action.type}
                        onChange={(e) => handleActionTypeChange(option.id, e.target.value as MenuAction["type"])}
                      >
                        <option value="goto">goto (another node)</option>
                        <option value="transfer">transfer (PSTN / SIP)</option>
                        <option value="handoff_llm">handoff_llm (Pipecat LLM)</option>
                        <option value="webhook">webhook (HTTP POST)</option>
                        <option value="end_call">end_call (speak &amp; hang up)</option>
                        <option value="reply_only">reply_only</option>
                      </select>
                    </label>

                    {option.action.type === "goto" && (
                      <label>
                        Target node
                        <select
                          value={option.action.target}
                          onChange={(e) =>
                            setGraph((curr) =>
                              updateNodeOption(curr, activeEditId, option.id, {
                                action: { type: "goto", target: e.target.value },
                              }),
                            )
                          }
                        >
                          {nodeIds.map((id) => (
                            <option key={id} value={id}>
                              {id}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>

                  {option.action.type === "transfer" && (
                    <div className="two-col">
                      <label>
                        Transfer target (E.164 or SIP URI)
                        <input
                          value={option.action.target}
                          onChange={(e) => {
                            if (option.action.type !== "transfer") return;
                            const nextAction: MenuAction = { ...option.action, target: e.target.value };
                            setGraph((curr) => updateNodeOption(curr, activeEditId, option.id, { action: nextAction }));
                          }}
                        />
                      </label>
                      <label>
                        Mode
                        <select
                          value={option.action.mode ?? "twilio_dial"}
                          onChange={(e) => {
                            if (option.action.type !== "transfer") return;
                            const nextAction: MenuAction = {
                              ...option.action,
                              mode: e.target.value as "twilio_dial" | "daily_sip_refer" | "custom",
                            };
                            setGraph((curr) => updateNodeOption(curr, activeEditId, option.id, { action: nextAction }));
                          }}
                        >
                          <option value="twilio_dial">twilio_dial</option>
                          <option value="daily_sip_refer">daily_sip_refer</option>
                          <option value="custom">custom</option>
                        </select>
                      </label>
                    </div>
                  )}

                  {option.action.type === "webhook" && (
                    <label>
                      Webhook URL (dry-run only in Studio)
                      <input
                        value={option.action.url}
                        onChange={(e) => {
                          if (option.action.type !== "webhook") return;
                          const nextAction: MenuAction = { ...option.action, url: e.target.value };
                          setGraph((curr) => updateNodeOption(curr, activeEditId, option.id, { action: nextAction }));
                        }}
                      />
                    </label>
                  )}

                  {option.action.type === "handoff_llm" && (
                    <label>
                      Specialist LLM system prompt
                      <input
                        value={option.action.systemPrompt ?? ""}
                        onChange={(e) =>
                          setGraph((curr) =>
                            updateNodeOption(curr, activeEditId, option.id, {
                              action: { type: "handoff_llm", systemPrompt: e.target.value },
                            }),
                          )
                        }
                      />
                    </label>
                  )}

                  <label>
                    Spoken reply {option.action.type === "goto" || option.action.type === "handoff_llm" ? "(optional bridge line)" : ""}
                    <input
                      value={option.reply}
                      onChange={(e) =>
                        setGraph((curr) => updateNodeOption(curr, activeEditId, option.id, { reply: e.target.value }))
                      }
                    />
                  </label>

                  <div className="row">
                    <button
                      className="secondary"
                      type="button"
                      style={{ padding: "5px 11px", fontSize: 12 }}
                      onClick={() => {
                        const { graph: next, createdNodeId } = addSubmenuNode(graph, activeEditId, option.id);
                        setGraph(next);
                        setSelectedNodeId(createdNodeId);
                      }}
                    >
                      + Branch into new submenu node
                    </button>
                  </div>
                </div>
              ))}

              <div className="row">
                <button
                  className="secondary"
                  type="button"
                  onClick={() => setGraph((curr) => addNodeOption(curr, activeEditId))}
                >
                  Add option
                </button>
              </div>

              <h2>Spoken prompt ({activeNode.id})</h2>
              <textarea
                value={activeNode.script}
                onChange={(e) => {
                  setTouchedScripts((prev) => setOwn(cloneRecord(prev), activeEditId, true));
                  setGraph((curr) => updateNodeFields(curr, activeEditId, { script: e.target.value }));
                }}
              />
              {hasOwn(touchedScripts, activeEditId) && touchedScripts[activeEditId] && (
                <div className="row">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => {
                      setTouchedScripts((prev) => setOwn(cloneRecord(prev), activeEditId, false));
                      const rewritten =
                        activeEditId === graph.entry
                          ? presentMenu(activeNode.name || graph.name, activeNode.options)
                          : presentDeeper(activeNode.name, activeNode.options);
                      setGraph((curr) => updateNodeFields(curr, activeEditId, { script: rewritten }));
                    }}
                  >
                    Rewrite prompt from option titles
                  </button>
                </div>
              )}

              {!validation.valid && (
                <div className="banner">
                  <strong>Graph errors:</strong> {validation.errors.map((err) => err.message).join(" · ")}
                </div>
              )}
            </>
          )}
        </section>

        <section>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2>Multi-Turn Jev Playground</h2>
            <button className="secondary" type="button" onClick={() => resetSimSession(simNodeId)}>
              Reset call
            </button>
          </div>

          <label>
            Active call node (stack depth: {simStack.length})
            <select value={simNodeId} onChange={(e) => resetSimSession(e.target.value)}>
              {nodeIds.map((id) => (
                <option key={id} value={id}>
                  {id} — {graph.nodes[id].name || "Menu"}
                </option>
              ))}
            </select>
          </label>

          <p className="hint">
            Prompt spoken at <strong>{simNodeId}</strong>: &ldquo;{graph.nodes[simNodeId]?.script}&rdquo;
          </p>

          <label>
            Caller utterance
            <input
              value={text}
              placeholder="I was charged twice last Tuesday"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void runTurn();
              }}
            />
          </label>

          <div className="row">
            <button className="secondary" type="button" onClick={() => void toggleRecording()}>
              {recording ? "Stop mic" : "Record mic"}
            </button>
            {recording && <span className="recording">Listening…</span>}
            {audio && (
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  URL.revokeObjectURL(audio.url);
                  setAudio(null);
                }}
              >
                Clear audio
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => void runTurn()}>
              {busy ? "Classifying…" : "Run turn"}
            </button>
          </div>

          {audio && <audio src={audio.url} controls />}
          {error && <p className="banner">{error}</p>}

          {result && (
            <div className="result">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="pill">
                  {result.outcomeChoice} ({(result.confidence * 100).toFixed(0)}%)
                </span>
                <span className="hint mono">
                  {result.ms}ms · {result.resolvedModel}
                </span>
              </div>

              {result.spokenReply ? (
                <strong>&ldquo;{result.spokenReply}&rdquo;</strong>
              ) : (
                <p className="hint">Silent pass-through into downstream Pipecat LLM.</p>
              )}

              <p className="hint">
                Heard ({result.path}): &ldquo;{result.transcript}&rdquo; → next node: <strong>{result.nextNodeId}</strong>
              </p>

              {result.terminalAction && (
                <p className="hint mono">
                  Dry-run action: {JSON.stringify(result.terminalAction)}
                </p>
              )}

              {Object.keys(result.extracted).length > 0 && (
                <p className="hint mono">Extracted facts: {JSON.stringify(result.extracted)}</p>
              )}

              <div className="prob-bars">
                {Object.entries(result.probabilities)
                  .sort((a, b) => b[1] - a[1])
                  .map(([choiceKey, prob]) => (
                    <div className="prob-row" key={choiceKey}>
                      <div className="prob-label">
                        <span>{choiceKey}</span>
                        <span>{(prob * 100).toFixed(1)}%</span>
                      </div>
                      <div className="prob-track">
                        <div className="prob-fill" style={{ width: `${Math.min(100, Math.max(0, prob * 100))}%` }} />
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
            <h2>Pipecat 1.16 Pipeline</h2>
            <button
              className="secondary"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(snippet).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied" : "Copy bot.py"}
            </button>
          </div>
          <pre className="snippet">
            <code>{snippet}</code>
          </pre>
        </section>
      </div>
    </main>
  );
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
