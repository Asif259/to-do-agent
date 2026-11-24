"use client";

import { useState } from "react";
import { CHANNEL_LABEL, type AppState, type DraftT } from "@/lib/client";
import { Icon } from "../ui";

const mailto = (d: DraftT) => `mailto:${encodeURIComponent(d.recipient)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;

export function ApprovalsView({
  state,
  onDecide,
  onOpen,
  say,
}: {
  state: AppState;
  onDecide: (id: number, decision: "approved" | "rejected") => void;
  onOpen: (taskId: number) => void;
  say: (text: string, error?: boolean) => void;
}) {
  const [tab, setTab] = useState<"waiting" | "cleared">("waiting");
  const list = tab === "waiting" ? state.approvals : state.cleared;

  async function copy(d: DraftT) {
    try {
      await navigator.clipboard.writeText(`${d.subject ? d.subject + "\n\n" : ""}${d.body}`);
      say("Copied");
    } catch {
      say("Could not copy. Select the text and copy it by hand.", true);
    }
  }

  return (
    <div className="approvals">
      <p className="safe-note">
        <Icon name="shield" size={16} />
        <span>
          This app never sends anything. Approving a draft only clears it, so you can copy it or open it in your mail app and send it yourself.
        </span>
      </p>

      <div className="segment segment-inline" role="tablist">
        <button role="tab" aria-selected={tab === "waiting"} className="segment-btn" onClick={() => setTab("waiting")}>
          Waiting <span className="count">{state.approvals.length}</span>
        </button>
        <button role="tab" aria-selected={tab === "cleared"} className="segment-btn" onClick={() => setTab("cleared")}>
          Cleared <span className="count">{state.cleared.length}</span>
        </button>
      </div>

      {list.length === 0 ? (
        <p className="empty">
          {tab === "waiting"
            ? "Nothing to approve. When the agent writes an email or message for you, it waits here."
            : "No approved drafts yet. Once you approve one, it appears here so you can copy and send it."}
        </p>
      ) : (
        <ul className="draftlist">
          {list.map((d) => (
            <li key={d.id} className="draftcard">
              <header>
                <span className="chip">{CHANNEL_LABEL[d.channel]}</span>
                <button className="link" onClick={() => onOpen(d.task_id)}>
                  {d.task_title}
                </button>
              </header>
              {(d.recipient || d.subject) && (
                <dl>
                  {d.recipient && (
                    <>
                      <dt>To</dt>
                      <dd>{d.recipient}</dd>
                    </>
                  )}
                  {d.subject && (
                    <>
                      <dt>Subject</dt>
                      <dd>{d.subject}</dd>
                    </>
                  )}
                </dl>
              )}
              <p className="draftcard-body">{d.body}</p>
              <footer>
                {tab === "waiting" ? (
                  <>
                    <button className="btn btn-primary btn-sm" onClick={() => onDecide(d.id, "approved")}>
                      <Icon name="check" size={14} /> Approve
                    </button>
                    <button className="btn btn-sm" onClick={() => onDecide(d.id, "rejected")}>
                      Reject
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-sm" onClick={() => void copy(d)}>
                      <Icon name="copy" size={14} /> Copy
                    </button>
                    {d.channel === "email" && (
                      <a className="btn btn-sm" href={mailto(d)}>
                        <Icon name="external" size={14} /> Open in mail app
                      </a>
                    )}
                  </>
                )}
              </footer>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
