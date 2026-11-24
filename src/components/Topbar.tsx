"use client";

import type { Health } from "@/lib/client";
import { Icon } from "./ui";

function modelText(h: Health | null): { text: string; tone: string } {
  if (!h) return { text: "Checking models", tone: "idle" };
  if (h.mode === "mock") return { text: "Demo mode", tone: "warn" };
  if (h.usable > 0) return { text: `${h.usable} ${h.usable === 1 ? "model" : "models"} ready`, tone: "ok" };
  if (h.total === 0) return { text: "No models yet", tone: "bad" };
  return { text: h.cooling > 0 ? "All cooling down" : "No model ready", tone: h.cooling > 0 ? "warn" : "bad" };
}

export function Topbar({ working, health, onModels, onData }: { working: boolean; health: Health | null; onModels: () => void; onData: () => void }) {
  const model = modelText(health);
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="topbar-mark" aria-hidden="true">
          <Icon name="agent" size={15} />
        </span>
        <span>To-Do Agent</span>
        {working && <span className="live-dot" aria-label="Working now" />}
      </div>
      <div className="topbar-actions">
        <span className={`topbar-status topbar-status-${model.tone}`}>
          <span className="status-dot" aria-hidden="true" />
          {model.text}
        </span>
        <button className="btn btn-sm" onClick={onModels}>
          <Icon name="sliders" size={14} /> Models
        </button>
        <button className="btn btn-sm" onClick={onData}>
          <Icon name="database" size={14} /> Your data
        </button>
      </div>
    </header>
  );
}
