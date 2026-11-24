"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { dataApi, type DataInfo } from "@/lib/client";
import { Icon } from "./ui";

const size = (bytes: number) => (bytes > 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);

const ACTIONS = [
  { scope: "tasks", label: "Clear all tasks", help: "Removes every task, result, draft and review. Keeps your API keys.", confirm: "Delete all tasks, results and drafts? This cannot be undone." },
  { scope: "keys", label: "Remove all API keys", help: "Removes every key and model. Keeps your tasks.", confirm: "Remove all API keys and models? You will need to add them again." },
  { scope: "all", label: "Delete everything", help: "Starts from scratch: tasks, keys, models and settings.", confirm: "Delete EVERYTHING: tasks, API keys, models and settings? This cannot be undone." },
] as const;

export function DataDrawer({ onClose, onChanged, say }: { onClose: () => void; onChanged: () => void; say: (text: string, error?: boolean) => void }) {
  const [info, setInfo] = useState<DataInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const load = useCallback(() => dataApi.info().then(setInfo).catch(() => undefined), []);

  useEffect(() => {
    panel.current?.focus();
    void load();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [load]);

  async function clear(a: (typeof ACTIONS)[number]) {
    if (!confirm(a.confirm)) return;
    setBusy(true);
    try {
      const res = await dataApi.clear(a.scope);
      setInfo(res);
      if (typeof window !== "undefined") {
        if (a.scope === "all") {
          localStorage.removeItem("todo_agent_storage");
          document.cookie = "todo_storage_sync=; path=/; max-age=0; SameSite=Lax";
        } else {
          const updated = await dataApi.export();
          localStorage.setItem("todo_agent_storage", JSON.stringify(updated));
          document.cookie = `todo_storage_sync=${Date.now()}; path=/; max-age=31536000; SameSite=Lax`;
        }
      }
      say("Done");
      onChanged();
    } catch (err) {
      say(err instanceof Error ? err.message : "Could not clear that", true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="data-title" tabIndex={-1} ref={panel}>
        <header className="drawer-head">
          <div className="drawer-meta">
            <Icon name="database" size={18} />
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </header>
        <h2 id="data-title" className="drawer-title">
          Your data
        </h2>
        <div className="drawer-scroll">
          <p className="lead">
            Everything is saved in your browser storage (<code>localStorage</code>) on localhost. Nothing is stored in a disk folder. Clearing your browser data or using the actions below resets your data.
          </p>

          {info && (
            <section className="block">
              <h3>Where it lives</h3>
              <p className="pathbox mono">{info.path}</p>
              <button className="link" onClick={() => void navigator.clipboard.writeText(info.path).then(() => say("Storage label copied"))}>
                <Icon name="copy" size={13} /> Copy location
              </button>
              <dl className="facts">
                <div>
                  <dt>Tasks</dt>
                  <dd>{info.tasks}</dd>
                </div>
                <div>
                  <dt>Drafts</dt>
                  <dd>{info.drafts}</dd>
                </div>
                <div>
                  <dt>API keys</dt>
                  <dd>{info.keys}</dd>
                </div>
                <div>
                  <dt>Models</dt>
                  <dd>{info.models}</dd>
                </div>
                <div>
                  <dt>Storage size</dt>
                  <dd>{size(info.bytes)}</dd>
                </div>
              </dl>
              <p className="hint">API keys are stored in your browser local storage. Do not export or share your browser storage contents with untrusted parties.</p>
            </section>
          )}

          <section className="block">
            <h3>Clear data</h3>
            <ul className="dangerlist">
              {ACTIONS.map((a) => (
                <li key={a.scope}>
                  <div>
                    <strong>{a.label}</strong>
                    <p className="hint">{a.help}</p>
                  </div>
                  <button className="btn btn-sm btn-danger-outline" disabled={busy} onClick={() => void clear(a)}>
                    <Icon name="trash" size={14} /> {a.scope === "all" ? "Delete" : "Clear"}
                  </button>
                </li>
              ))}
            </ul>
            <p className="hint">Prefer browser settings? Clearing site data and cookies for localhost will also reset your data.</p>
          </section>
        </div>
      </aside>
    </div>
  );
}
