"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { llmApi, timeOf, type RouterState, type TestResult } from "@/lib/client";
import type { UiModel } from "@/lib/router/types";
import { Icon } from "./ui";

type Tab = "keys" | "models" | "test";
const TABS: { id: Tab; label: string }[] = [
  { id: "keys", label: "Keys" },
  { id: "models", label: "Models" },
  { id: "test", label: "Test and log" },
];

function secondsLeft(iso: string | null, now: number): number {
  return iso ? Math.ceil((Date.parse(iso) - now) / 1000) : 0;
}

function fmt(s: number): string {
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

export function ModelsDrawer({
  mode,
  onClose,
  onChanged,
  say,
}: {
  mode: "live" | "mock";
  onClose: () => void;
  onChanged: () => void;
  say: (text: string, error?: boolean) => void;
}) {
  const [state, setState] = useState<RouterState | null>(null);
  const [tab, setTab] = useState<Tab>("keys");
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState<boolean | null>(null); // null = show only while there are no keys
  const panel = useRef<HTMLElement>(null);

  const [form, setForm] = useState({ preset: "openrouter", label: "", api_key: "", base_url: "", name: "" });
  const [prompt, setPrompt] = useState("Reply with one short sentence.");
  const [test, setTest] = useState<{ result?: TestResult; error?: string; ms?: number } | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await llmApi.state());
    } catch {
      /* next tick retries */
    }
  }, []);

  // The parent re-renders on every poll, so keep the latest onClose in a ref and attach listeners once.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    panel.current?.focus(); // once, on open: refocusing later would steal focus from whatever is being typed in
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      window.removeEventListener("keydown", onKey);
    };
  }, [load]);

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
    } catch (err) {
      say(err instanceof Error ? err.message : "Something went wrong", true);
    } finally {
      setBusy(null);
      await load();
      onChanged();
    }
  }

  const statusOf = (m: UiModel) =>
    m.status === "cooling_down" && secondsLeft(m.cooldown_until, now) <= 0 ? "active" : m.status;

  const counts = useMemo(() => {
    const c = { ready: 0, cooling: 0, off: 0 };
    for (const m of state?.models ?? []) {
      const s = statusOf(m);
      if (!m.enabled || s === "disabled") c.off++;
      else if (s === "cooling_down") c.cooling++;
      else c.ready++;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, now]);

  const models = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = state?.models ?? [];
    return q ? all.filter((m) => `${m.model_id} ${m.provider} ${m.key_label}`.toLowerCase().includes(q)) : all;
  }, [state, filter]);

  const isCustom = form.preset === "custom";

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer drawer-wide" role="dialog" aria-modal="true" aria-labelledby="models-title" tabIndex={-1} ref={panel}>
        <header className="drawer-head">
          <div className="drawer-meta">
            <Icon name="sliders" size={18} />
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </header>
        <h2 id="models-title" className="drawer-title">
          Model configuration
        </h2>
        <p className="quiet-note">
          Every call the agent makes goes through this pool. When a model hits a limit or a key stops working, the next one takes over.
        </p>

        {mode === "mock" && (
          <p className="banner banner-demo" role="status">
            Demo mode is on, so the agent ignores this pool. Set <code>LLM_MODE=live</code> in <code>.env.local</code> to use it.
          </p>
        )}

        <div className="stats" aria-label="Pool summary">
          <div>
            <strong>{counts.ready}</strong>
            <span>ready</span>
          </div>
          <div>
            <strong>{counts.cooling}</strong>
            <span>cooling down</span>
          </div>
          <div>
            <strong>{counts.off}</strong>
            <span>off</span>
          </div>
        </div>

        <div className="strategy">
          <span id="strategy-label">Order</span>
          <div className="segment" role="radiogroup" aria-labelledby="strategy-label">
            {(
              [
                ["waterfall", "Priority first"],
                ["round_robin", "Round-robin"],
              ] as const
            ).map(([id, text]) => (
              <button
                key={id}
                role="radio"
                aria-checked={state?.strategy === id}
                className="segment-btn"
                onClick={() => void run("strategy", async () => void (await llmApi.setStrategy(id)))}
              >
                {text}
              </button>
            ))}
          </div>
          <p className="hint">
            {state?.strategy === "round_robin"
              ? "Spreads calls across every ready model in turn."
              : "Always tries the lowest priority number first, and moves on only when it fails."}
          </p>
        </div>

        <div className="segment tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className="segment-btn" aria-checked={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="drawer-scroll">
          {!state && <p className="quiet-note">Loading</p>}

          {state && tab === "keys" && (
            <>
              {state.providers.length === 0 ? (
                <p className="quiet-note">No keys yet. Free tiers from OpenRouter, Groq, Gemini, Mistral and Cerebras all work.</p>
              ) : (
                state.providers.map((p) => (
                  <section className="provider" key={p.id}>
                    <header>
                      <div>
                        <h3>{p.name}</h3>
                        <p className="mono hint">{p.base_url}</p>
                      </div>
                      {p.preset === "openrouter" && (
                        <label className="toggle-line">
                          <span>Free models only</span>
                          <input
                            type="checkbox"
                            checked={p.free_only}
                            onChange={(e) =>
                              void run("free" + p.id, async () => {
                                await llmApi.freeOnly(p.id, e.target.checked);
                                say("Saved. Sync the key to apply it.");
                              })
                            }
                          />
                        </label>
                      )}
                    </header>
                    <ul>
                      {p.keys.map((k) => (
                        <li key={k.id} className="keyrow">
                          <div className="keyrow-main">
                            <div className="keyrow-title">
                              <strong>{k.label}</strong>
                              <span className={`pill ${k.status === "active" ? "pill-ready" : "pill-danger"}`}>
                                <span className="pill-dot" aria-hidden="true" />
                                {k.status === "active" ? "Active" : "Disabled"}
                              </span>
                            </div>
                            <p className="mono hint">
                              {k.masked_key} · {k.model_count} {k.model_count === 1 ? "model" : "models"}
                            </p>
                            {k.last_error && <p className="row-error">{k.last_error}</p>}
                          </div>
                          <div className="keyrow-actions">
                            <button
                              className="btn btn-sm"
                              disabled={busy === "sync" + k.id}
                              onClick={() =>
                                void run("sync" + k.id, async () => {
                                  const r = await llmApi.syncKey(k.id);
                                  say(`${k.label}: ${r.added} added, ${r.kept} kept, ${r.removed} removed.`);
                                })
                              }
                            >
                              <Icon name="refresh" size={14} /> {busy === "sync" + k.id ? "Syncing" : "Sync models"}
                            </button>
                            {k.status !== "active" && (
                              <button className="btn btn-sm" onClick={() => void run("on" + k.id, () => llmApi.setKeyStatus(k.id, "active"))}>
                                Re-enable
                              </button>
                            )}
                            <button
                              className="icon-btn icon-btn-sm"
                              aria-label={`Delete key ${k.label}`}
                              onClick={() => {
                                if (!confirm(`Delete the key “${k.label}” and its ${k.model_count} models?`)) return;
                                void run("del" + k.id, () => llmApi.deleteKey(k.id));
                              }}
                            >
                              <Icon name="trash" size={15} />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
              )}

              {state.providers.length > 0 && showForm !== true ? (
                <button className="btn" onClick={() => setShowForm(true)}>
                  <Icon name="plus" size={15} /> Add another key
                </button>
              ) : (
              <form
                className="keyform"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("add", async () => {
                    const { id } = await llmApi.addKey({
                      preset: form.preset,
                      label: form.label,
                      api_key: form.api_key,
                      ...(isCustom ? { base_url: form.base_url, name: form.name || undefined } : {}),
                    });
                    setForm((f) => ({ ...f, label: "", api_key: "" }));
                    setShowForm(false);
                    try {
                      const r = await llmApi.syncKey(id);
                      say(`Key added. ${r.total} ${r.total === 1 ? "model" : "models"} found.`);
                    } catch (err) {
                      say(`Key added, but syncing its models failed: ${err instanceof Error ? err.message : "unknown error"}. Use Sync models on the key.`, true);
                    }
                  });
                }}
              >
                <h3>Add an API key</h3>
                <div className="form-grid">
                  <label>
                    <span>Provider</span>
                    <select className="input" value={form.preset} onChange={(e) => setForm({ ...form, preset: e.target.value })}>
                      {state.presets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Label</span>
                    <input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Personal" maxLength={60} required />
                  </label>
                  {isCustom && (
                    <>
                      <label className="span-2">
                        <span>Base URL</span>
                        <input className="input mono" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="http://localhost:11434/v1" required />
                      </label>
                      <label className="span-2">
                        <span>Name (optional)</span>
                        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ollama" maxLength={60} />
                      </label>
                    </>
                  )}
                  <label className="span-2">
                    <span>API key</span>
                    <input className="input mono" type="password" autoComplete="off" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder="Paste the key" required />
                  </label>
                </div>
                <p className="hint">Keys are stored on this computer, unencrypted, in <code>data/todo.db</code>. They are shown masked here.</p>
                <button className="btn btn-primary" disabled={busy === "add"}>
                  <Icon name="plus" size={15} /> Add key
                </button>
              </form>
              )}
            </>
          )}

          {state && tab === "models" && (
            <>
              <div className="toolbar">
                <input className="input" type="search" placeholder="Filter models" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter models" />
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void run("reset", async () => {
                      const r = await llmApi.resetCooldowns();
                      say(`${r.reset} cooldown${r.reset === 1 ? "" : "s"} cleared.`);
                    })
                  }
                >
                  Clear cooldowns
                </button>
              </div>
              {models.length === 0 ? (
                state.models.length ? (
                  <p className="quiet-note">No models match.</p>
                ) : (
                  <div className="empty-models">
                    <p className="quiet-note">
                      {state.providers.length
                        ? "These keys have no models yet. Sync pulls the list from the provider."
                        : "No models yet. Add an API key first."}
                    </p>
                    {state.providers
                      .flatMap((p) => p.keys.map((k) => ({ ...k, provider: p.name })))
                      .filter((k) => k.model_count === 0)
                      .map((k) => (
                        <button
                          key={k.id}
                          className="btn btn-sm"
                          disabled={busy === "sync" + k.id}
                          onClick={() =>
                            void run("sync" + k.id, async () => {
                              const r = await llmApi.syncKey(k.id);
                              say(`${k.provider}, ${k.label}: ${r.total} models found.`);
                            })
                          }
                        >
                          <Icon name="refresh" size={14} /> {busy === "sync" + k.id ? "Syncing" : `Sync ${k.provider}, ${k.label}`}
                        </button>
                      ))}
                    {state.providers.length === 0 && (
                      <button className="btn btn-sm" onClick={() => setTab("keys")}>
                        Go to Keys
                      </button>
                    )}
                  </div>
                )
              ) : (
                <ul className="models">
                  {models.map((m) => {
                    const s = statusOf(m);
                    return (
                      <li key={m.id} className={m.enabled ? "" : "model-off"}>
                        <input
                          type="checkbox"
                          className="switch-check"
                          checked={m.enabled}
                          aria-label={`Use ${m.model_id}`}
                          onChange={(e) => void run("m" + m.id, () => llmApi.patchModel(m.id, { enabled: e.target.checked }))}
                        />
                        <div className="model-main">
                          <strong className="mono">{m.model_id}</strong>
                          <span className="hint">
                            {m.provider}, {m.key_label}
                          </span>
                          {m.last_error && s !== "active" && <span className="row-error" title={m.last_error}>{m.last_error}</span>}
                        </div>
                        <label className="prio">
                          <span>Priority</span>
                          <input
                            key={`${m.id}:${m.priority}`}
                            type="number"
                            min={0}
                            max={9999}
                            className="input mono"
                            defaultValue={m.priority}
                            onBlur={(e) => {
                              const n = Number.parseInt(e.target.value, 10);
                              if (Number.isNaN(n) || n === m.priority) return void (e.target.value = String(m.priority));
                              void run("p" + m.id, () => llmApi.patchModel(m.id, { priority: n }));
                            }}
                            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                          />
                        </label>
                        <span className={`pill ${s === "cooling_down" ? "pill-attention" : s === "disabled" ? "pill-danger" : "pill-ready"}`}>
                          <span className="pill-dot" aria-hidden="true" />
                          {s === "cooling_down" ? `Cooling ${fmt(secondsLeft(m.cooldown_until, now))}` : s === "disabled" ? "Disabled" : "Ready"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="hint">Lower priority numbers are tried first. Switching a model back on clears its cooldown and error.</p>
            </>
          )}

          {state && tab === "test" && (
            <>
              <form
                className="keyform"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("test", async () => {
                    const t0 = performance.now();
                    try {
                      const result = await llmApi.test(prompt);
                      setTest({ result, ms: Math.round(performance.now() - t0) });
                    } catch (err) {
                      setTest({ error: err instanceof Error ? err.message : "The test failed", ms: Math.round(performance.now() - t0) });
                    }
                  });
                }}
              >
                <h3>Send a test message</h3>
                <textarea className="input" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} required />
                <button className="btn btn-primary" disabled={busy === "test"}>
                  {busy === "test" ? "Sending" : "Send through the pool"}
                </button>
              </form>

              {test && (
                <section className={`block ${test.error ? "block-danger" : ""}`}>
                  {test.result ? (
                    <>
                      <h3>
                        Answered by {test.result.provider}, {test.result.model}
                      </h3>
                      <p className="hint">
                        {test.result.attempts} {test.result.attempts === 1 ? "try" : "tries"}, {test.ms} ms
                      </p>
                      <pre className="artifact">{test.result.text}</pre>
                    </>
                  ) : (
                    <>
                      <h3>The test did not go through</h3>
                      <p>{test.error}</p>
                    </>
                  )}
                </section>
              )}

              <section className="block">
                <h3>Recent requests</h3>
                {state.logs.length === 0 ? (
                  <p className="quiet-note">Nothing yet. Every agent call is listed here.</p>
                ) : (
                  <ol className="requests">
                    {state.logs.map((l) => (
                      <li key={l.id}>
                        <time>{timeOf(l.ts)}</time>
                        <span className={`pill ${l.status_code < 300 ? "pill-ready" : l.status_code < 500 ? "pill-attention" : "pill-danger"}`}>{l.status_code}</span>
                        <div>
                          <strong>{l.provider ? `${l.provider}, ${l.model}` : "No model answered"}</strong>
                          <span className="hint">
                            {l.role}, {l.attempts} {l.attempts === 1 ? "try" : "tries"}, {l.latency_ms} ms
                          </span>
                          {l.note && <span className="hint">{l.note}</span>}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
