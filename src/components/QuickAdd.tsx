"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/client";
import { Icon } from "./ui";

export const SAMPLE_TASKS = `Draft the Q4 summary for the team
Compare health insurance renewal options
Email the landlord about the leaking tap
Book a dentist appointment
Call Mum about her birthday plans
Plan next week's meals and a grocery list
Pay the electricity bill
Go for a 30 minute run`;

/** One always-visible bar. Enter adds. Shift+Enter makes a new line. Pasting a list adds one task per line. */
export function QuickAdd({ onAdded, say }: { onAdded: () => void; say: (text: string, error?: boolean) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const lines = text.split("\n").filter((l) => l.trim()).length;

  async function submit() {
    if (!lines || busy) return;
    setBusy(true);
    try {
      await api.addTasks(text);
      say(lines === 1 ? "Added to the queue. Click Get it done to start." : `Added ${lines} tasks. Click Get it done to start.`);
      setText("");
      onAdded();
    } catch (err) {
      say(err instanceof Error ? err.message : "Could not add tasks", true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={`quickadd ${lines > 1 ? "quickadd-multi" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Icon name="plus" size={16} />
      <textarea
        id="quick-add"
        ref={area}
        value={text}
        rows={lines > 1 ? Math.min(lines, 6) : 1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="Add anything on your mind"
        aria-label="Add tasks. Press Enter to add, Shift and Enter for a new line."
      />
      <span className="quickadd-hint">{lines > 1 ? `${lines} tasks` : text ? "Press ↵ to add" : <kbd>N</kbd>}</span>
      <button className="btn btn-primary btn-sm" disabled={!lines || busy}>
        {busy ? "Adding" : "Add"}
      </button>
    </form>
  );
}
