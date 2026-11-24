"use client";

import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { agentLabel, api, CATEGORY_LABEL, CHANNEL_LABEL, PILE_META, timeOf, type Detail } from "@/lib/client";
import { PILES, type Pile } from "@/lib/types";
import { CategoryTag, Icon, StatusPill } from "./ui";

interface Props {
  detail: Detail;
  onClose: () => void;
  onChanged: () => void;
  say: (text: string, error?: boolean) => void;
}

const mailto = (d: { recipient: string; subject: string; body: string }) =>
  `mailto:${encodeURIComponent(d.recipient)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;

/** Everything about one task: what the agent did, what is left for you, drafts, the result and the review. */
export function TaskDetail({ detail, onClose, onChanged, say }: Props) {
  const { task, steps, artifacts, drafts, reviews, events } = detail;
  const busy = ["triaging", "working", "reviewing"].includes(task.status);

  async function run(fn: () => Promise<void>, ok?: string) {
    try {
      await fn();
      if (ok) say(ok);
      onChanged();
    } catch (err) {
      say(err instanceof Error ? err.message : "Something went wrong", true);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      say("Copied");
    } catch {
      say("Could not copy. Select the text and copy it by hand.", true);
    }
  }

  const stepsLeft = steps.filter((s) => !s.done).length;

  return (
    <div className="detail">
      <header className="detail-head">
        <div className="detail-meta">
          <StatusPill task={task} />
          <CategoryTag category={task.category} label={CATEGORY_LABEL[task.category]} />
          {task.priority === 1 && <span className="chip chip-high">High priority</span>}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={18} />
        </button>
      </header>

      <h2 className="detail-title">{task.title}</h2>
      {task.notes && <p className="quiet-note">{task.notes}</p>}

      <div className="detail-scroll">
        {task.pile && (
          <div>
            <div className="segment" role="radiogroup" aria-label="Who does this">
              {PILES.map((p: Pile) => (
                <button
                  key={p}
                  role="radio"
                  aria-checked={task.pile === p}
                  className="segment-btn"
                  disabled={busy}
                  onClick={() => task.pile !== p && void run(() => api.taskAction(task.id, { action: "move", pile: p }))}
                >
                  {PILE_META[p].title}
                </button>
              ))}
            </div>
            {task.rationale && <p className="why">{task.rationale}</p>}
          </div>
        )}

        {task.status === "failed" && (
          <section className="block block-danger">
            <h3>The agent could not finish this</h3>
            <p>{task.error}</p>
            <button className="btn btn-sm" onClick={() => void run(() => api.taskAction(task.id, { action: "rerun" }), "Sent back to the agent")}>
              <Icon name="refresh" size={14} /> Try again
            </button>
          </section>
        )}

        {task.verdict === "flag" && task.review_notes && task.status !== "done" && (
          <section className="block block-warn">
            <h3>The reviewer wants you to look at this</h3>
            <p className="prewrap">{task.review_notes}</p>
          </section>
        )}

        {task.summary && (
          <section className="block">
            <h3>What the agent did</h3>
            <p>{task.summary}</p>
          </section>
        )}

        {steps.length > 0 && (
          <section className="block">
            <h3>
              Your part <span className="count">{stepsLeft === 0 ? "all done" : `${stepsLeft} left`}</span>
            </h3>
            <ul className="steps">
              {steps.map((s) => (
                <li key={s.id}>
                  <label>
                    <input type="checkbox" checked={!!s.done} onChange={(e) => void run(() => api.step(s.id, e.target.checked))} />
                    <span className={s.done ? "step-done" : ""}>{s.text}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}

        {drafts.length > 0 && (
          <section className="block">
            <h3>Drafts</h3>
            <ul className="drafts">
              {drafts.map((d) => (
                <li key={d.id} className={`draft draft-${d.status}`}>
                  <div className="draft-top">
                    <span className="chip">{CHANNEL_LABEL[d.channel]}</span>
                    <span className="draft-status">
                      {d.status === "pending" && "Waiting for your approval"}
                      {d.status === "approved" && "Approved. Send it yourself."}
                      {d.status === "rejected" && "Rejected"}
                    </span>
                  </div>
                  {(d.recipient || d.subject) && (
                    <p className="draft-line">
                      {d.recipient && <span>To {d.recipient}</span>}
                      {d.subject && <strong>{d.subject}</strong>}
                    </p>
                  )}
                  <p className="draft-body draft-body-full">{d.body}</p>
                  <div className="draft-actions">
                    {d.status === "pending" && (
                      <>
                        <button className="btn btn-primary btn-sm" onClick={() => void run(() => api.decide(d.id, "approved"), "Approved")}>
                          <Icon name="check" size={14} /> Approve
                        </button>
                        <button className="btn btn-sm" onClick={() => void run(() => api.decide(d.id, "rejected"))}>
                          Reject
                        </button>
                      </>
                    )}
                    {d.status === "approved" && (
                      <>
                        <button className="btn btn-sm" onClick={() => void copy(`${d.subject ? d.subject + "\n\n" : ""}${d.body}`)}>
                          <Icon name="copy" size={14} /> Copy
                        </button>
                        {d.channel === "email" && (
                          <a className="btn btn-sm" href={mailto(d)}>
                            <Icon name="external" size={14} /> Open in mail app
                          </a>
                        )}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {artifacts.map((a) => (
          <section className="block" key={a.id}>
            <div className="block-head">
              <h3>{a.title}</h3>
              <button className="link" onClick={() => void copy(a.body)}>
                <Icon name="copy" size={13} /> Copy
              </button>
            </div>
            <pre className="artifact">{a.body}</pre>
          </section>
        ))}

        {task.deliverable && (
          <section className="block">
            <div className="block-head">
              <h3>Result</h3>
              <button className="link" onClick={() => void copy(task.deliverable ?? "")}>
                <Icon name="copy" size={13} /> Copy
              </button>
            </div>
            <div className="md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.deliverable}</ReactMarkdown>
            </div>
          </section>
        )}

        {reviews.length > 0 && (
          <section className="block">
            <h3>Review</h3>
            <ol className="rounds">
              {reviews.map((r) => {
                const issues = JSON.parse(r.issues) as string[];
                return (
                  <li key={r.id}>
                    <span className={`verdict verdict-${r.verdict}`}>{r.verdict === "pass" ? "Passed" : r.verdict === "revise" ? "Sent back" : "Flagged"}</span>
                    <div>
                      {r.notes && <p>{r.notes}</p>}
                      {issues.length > 0 && (
                        <ul>
                          {issues.map((i, n) => (
                            <li key={n}>{i}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {events.length > 0 && (
          <details className="block">
            <summary>Activity</summary>
            <ol className="feed">
              {events.map((e) => (
                <li key={e.id} className={e.kind === "error" ? "feed-error" : ""}>
                  <time>{timeOf(e.ts)}</time>
                  <span className="feed-agent">{agentLabel(e.agent)}</span>
                  <span className="feed-msg">{e.message}</span>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>

      <footer className="detail-foot">
        {task.status === "done" ? (
          <button className="btn" onClick={() => void run(() => api.taskAction(task.id, { action: "reopen" }))}>
            Reopen
          </button>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => api.taskAction(task.id, { action: "done" }), "Marked done")}>
            <Icon name="check" size={15} /> {task.status === "ready" ? "Accept result" : "Mark done"}
          </button>
        )}
        <button className="btn" disabled={busy} onClick={() => void run(() => api.taskAction(task.id, { action: "rerun" }), "Sent back to the agent")}>
          <Icon name="refresh" size={15} /> Run again
        </button>
        <button
          className="btn btn-danger"
          disabled={busy}
          onClick={() => {
            if (!confirm(`Delete “${task.title}”? This cannot be undone.`)) return;
            void api
              .deleteTask(task.id)
              .then(() => {
                onClose();
                onChanged();
              })
              .catch((err: unknown) => say(err instanceof Error ? err.message : "Could not delete", true));
          }}
        >
          <Icon name="trash" size={15} /> Delete
        </button>
      </footer>
    </div>
  );
}

/** Slide-over wrapper used when the detail does not sit inline. */
export function TaskDrawer(props: Props) {
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;

  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <aside className="drawer drawer-detail" role="dialog" aria-modal="true" aria-label={props.detail.task.title} tabIndex={-1} ref={panel}>
        <TaskDetail {...props} />
      </aside>
    </div>
  );
}
