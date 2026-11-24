import { askJson } from "./agents/ask";
import { reviewMessages, triageMessages, workerMessages } from "./agents/prompts";
import type { Config } from "./config";
import type { Db } from "./db";
import type { Llm } from "./llm";
import { Lanes, Serial } from "./pool";
import {
  addReview,
  claimInbox,
  getTask,
  logEvent,
  saveWork,
  updateTask,
} from "./store";
import {
  ReviewResultSchema,
  TriageResultSchema,
  WorkerResultSchema,
  type ReviewResult,
  type TaskRow,
} from "./types";

export interface Deps {
  db: Db;
  llm: Llm;
  config: Config;
  /** Shared across runs so the worker limit and the single reviewer hold globally. */
  lanes: Lanes;
  reviewer: Serial;
}

export function createDeps(db: Db, llm: Llm, config: Config): Deps {
  return { db, llm, config, lanes: new Lanes(config.workerConcurrency), reviewer: new Serial() };
}

const TRIAGE_BATCH = 10;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Take every task waiting in the inbox: triage them, work them in parallel, and have the
 * single reviewer check each result. Safe to call while another run is in progress.
 */
export async function processInbox(deps: Deps): Promise<number> {
  const claimed = claimInbox(deps.db);
  if (!claimed.length) return 0;
  logEvent(deps.db, { agent: "system", kind: "info", message: `Picked up ${claimed.length} task(s).` });

  for (let i = 0; i < claimed.length; i += TRIAGE_BATCH) {
    await triage(deps, claimed.slice(i, i + TRIAGE_BATCH));
  }

  const queued = claimed.filter((t) => getTask(deps.db, t.id)?.status === "working");
  await Promise.all(queued.map((t) => runTask(deps, t.id)));
  return claimed.length;
}

// ------------------------------------------------------------------------- triage

async function triage(deps: Deps, batch: TaskRow[]): Promise<void> {
  const { db, llm } = deps;
  try {
    const result = await askJson(
      llm,
      "triage",
      triageMessages(batch.map(({ id, title, notes }) => ({ id, title, notes }))),
      TriageResultSchema,
    );
    const byId = new Map(result.items.map((item) => [item.id, item]));
    for (const task of batch) {
      const t = byId.get(task.id);
      if (!t) {
        updateTask(db, task.id, {
          pile: "together",
          category: "other",
          priority: 2,
          rationale: "Triage did not return this item, so it was placed in Together.",
          status: "working",
          agent: null,
        });
        logEvent(db, { task_id: task.id, agent: "triage", kind: "info", message: "No triage answer; defaulted to Together." });
        continue;
      }
      updateTask(db, task.id, {
        title: t.title,
        notes: task.notes ?? (t.title !== task.title ? `Original: ${task.title}` : null),
        category: t.category,
        pile: t.pile,
        priority: t.priority,
        rationale: t.rationale,
        status: "working",
        agent: null,
      });
      logEvent(db, { task_id: task.id, agent: "triage", kind: "done", message: `Sorted into ${t.pile} · ${t.category}` });
    }
  } catch (err) {
    for (const task of batch) {
      updateTask(db, task.id, { status: "failed", agent: null, error: `Triage failed: ${message(err)}` });
      logEvent(db, { task_id: task.id, agent: "triage", kind: "error", message: `Triage failed: ${message(err)}` });
    }
  }
}

// ------------------------------------------------------------------------- work + review

/** A worker lane is held only while the worker writes, never while the task waits for review. */
async function runTask(deps: Deps, id: number): Promise<void> {
  const { db, llm, config } = deps;
  let lane = "worker";
  try {
    let feedback: string[] | undefined;
    for (let round = 0; ; round++) {
      const task = getTask(db, id);
      if (!task || !task.pile) return; // deleted or never triaged

      const slot = await deps.lanes.acquire();
      let work;
      try {
        lane = `worker-${slot + 1}`;
        updateTask(db, id, { status: "working", agent: lane });
        logEvent(db, {
          task_id: id,
          agent: lane,
          kind: "start",
          message: round === 0 ? `Working on “${task.title}”` : `Revising “${task.title}” after review`,
        });
        work = await askJson(llm, "worker", workerMessages(task, task.pile, feedback), WorkerResultSchema);
        saveWork(db, id, work);
      } finally {
        deps.lanes.release(slot);
      }

      updateTask(db, id, { status: "reviewing", agent: "reviewer" });
      const review = await deps.reviewer.run(async (): Promise<ReviewResult> => {
        logEvent(db, { task_id: id, agent: "reviewer", kind: "start", message: `Checking “${task.title}”` });
        try {
          const { deliverable: _skip, ...brief } = task; // eslint-disable-line @typescript-eslint/no-unused-vars
          return await askJson(llm, "reviewer", reviewMessages(brief, work), ReviewResultSchema);
        } catch (err) {
          // Never wave work through unchecked: an unavailable reviewer means "look at this yourself".
          return { verdict: "flag", issues: [], notes: `Not independently checked: reviewer unavailable (${message(err)})` };
        }
      });
      addReview(db, id, round, review);

      if (review.verdict === "revise" && round < config.maxRevisions) {
        feedback = review.issues.length ? review.issues : [review.notes || "The reviewer asked for changes."];
        logEvent(db, { task_id: id, agent: "reviewer", kind: "review", message: `Asked for changes (${feedback.length})` });
        continue;
      }

      const passed = review.verdict === "pass";
      const notes = [
        review.notes,
        ...review.issues.map((i) => `• ${i}`),
        review.verdict === "revise" ? "The issues above remained after one revision." : "",
      ].filter(Boolean);
      updateTask(db, id, {
        status: passed && task.pile === "agent" ? "ready" : "needs_you",
        agent: null,
        verdict: passed ? "pass" : "flag",
        review_notes: notes.join("\n") || null,
        error: null,
      });
      logEvent(db, {
        task_id: id,
        agent: "reviewer",
        kind: "review",
        message: passed ? "Passed review" : "Flagged for your attention",
      });
      return;
    }
  } catch (err) {
    updateTask(db, id, { status: "failed", agent: null, error: message(err) });
    logEvent(db, { task_id: id, agent: lane, kind: "error", message: message(err) });
  }
}
