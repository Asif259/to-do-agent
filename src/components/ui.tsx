"use client";

import type { ReactNode } from "react";
import type { TaskCardT } from "@/lib/client";
import { PILE_META } from "@/lib/client";
import type { Pile } from "@/lib/types";

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    check: <path d="m4 12.5 5 5L20 6.5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    play: <path d="M7 5v14l12-7z" />,
    x: <path d="M6 6l12 12M18 6 6 18" />,
    copy: (
      <>
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V6a2 2 0 0 1 2-2h8" />
      </>
    ),
    refresh: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />,
    trash: <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13" />,
    shield: <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" />,
    sliders: <path d="M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6" />,
    today: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </>
    ),
    board: (
      <>
        <rect x="3" y="4" width="5" height="16" rx="1.2" />
        <rect x="10" y="4" width="5" height="10" rx="1.2" />
        <rect x="17" y="4" width="4" height="13" rx="1.2" />
      </>
    ),
    mail: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </>
    ),
    agent: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />,
    database: (
      <>
        <ellipse cx="12" cy="6" rx="7" ry="3" />
        <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="6" />
        <path d="m20 20-4.3-4.3" />
      </>
    ),
    external: <path d="M14 4h6v6M20 4l-9 9M10 6H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

const STATUS: Record<string, { label: string; tone: string }> = {
  inbox: { label: "Queued", tone: "quiet" },
  triaging: { label: "Sorting", tone: "live" },
  working: { label: "Working", tone: "live" },
  reviewing: { label: "Being checked", tone: "live" },
  ready: { label: "Ready", tone: "ready" },
  needs_you: { label: "Needs you", tone: "attention" },
  done: { label: "Done", tone: "quiet" },
  failed: { label: "Failed", tone: "danger" },
};

export function StatusPill({ task }: { task: Pick<TaskCardT, "status" | "agent"> }) {
  const base = STATUS[task.status];
  const queued = task.status === "working" && !task.agent;
  return (
    <span className={`pill pill-${queued ? "quiet" : base.tone}`}>
      <span className="pill-dot" aria-hidden="true" />
      {queued ? "Queued" : base.label}
    </span>
  );
}

export function CategoryTag({ category, label }: { category: string; label: string }) {
  return (
    <span className="cat">
      <span className={`cat-dot cat-${category}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function PileTag({ pile }: { pile: Pile }) {
  return <span className={`piletag piletag-${pile}`}>{PILE_META[pile].short}</span>;
}
