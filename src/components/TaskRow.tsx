"use client";

import { CATEGORY_LABEL, isBusy, type TaskCardT } from "@/lib/client";
import { CategoryTag, Icon, PileTag, StatusPill } from "./ui";

export function TaskRow({
  task,
  selected,
  showPile,
  onSelect,
  onToggle,
  onRetry,
}: {
  task: TaskCardT;
  selected: boolean;
  showPile: boolean;
  onSelect: (id: number) => void;
  onToggle: (task: TaskCardT) => void;
  onRetry: (id: number) => void;
}) {
  const done = task.status === "done";
  return (
    <li className={`trow ${selected ? "trow-selected" : ""} ${done ? "trow-done" : ""} ${task.pile ? `trow-${task.pile}` : ""}`}>
      <button
        className="check"
        onClick={() => onToggle(task)}
        disabled={isBusy(task.status)}
        aria-label={done ? `Mark “${task.title}” as not done` : `Mark “${task.title}” as done`}
        aria-pressed={done}
      >
        {done && <Icon name="check" size={13} />}
      </button>
      <button className="trow-main" onClick={() => onSelect(task.id)} aria-current={selected ? "true" : undefined}>
        <span className="trow-title">{task.title}</span>
        {task.status === "failed" ? (
          <span className="trow-error">{task.error}</span>
        ) : (
          task.summary && <span className="trow-summary">{task.summary}</span>
        )}
        <span className="trow-meta">
          <StatusPill task={task} />
          <CategoryTag category={task.category} label={CATEGORY_LABEL[task.category]} />
          {task.priority === 1 && <span className="chip chip-high">High</span>}
          {task.steps_total > 0 && task.pile !== "agent" && (
            <span className="chip">
              {task.steps_done} of {task.steps_total} steps
            </span>
          )}
          {task.pending_drafts > 0 && <span className="chip chip-draft">{task.pending_drafts === 1 ? "Draft to approve" : `${task.pending_drafts} drafts`}</span>}
          {task.verdict === "flag" && !done && <span className="chip chip-flag">Check this</span>}
        </span>
      </button>
      <div className="trow-side">
        {showPile && task.pile && <PileTag pile={task.pile} />}
        {task.status === "failed" && (
          <button className="link" onClick={() => onRetry(task.id)}>
            Try again
          </button>
        )}
      </div>
    </li>
  );
}
