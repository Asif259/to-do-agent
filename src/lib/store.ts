import type { Db } from "./db";
import type {
  ArtifactRow,
  EventRow,
  OutboxRow,
  ReviewResult,
  ReviewRow,
  StepRow,
  TaskRow,
  WorkerResult,
} from "./types";

// ------------------------------------------------------------------------- writes

export function addTasks(db: Db, items: { title: string; notes?: string }[]): number[] {
  const insert = db.prepare("INSERT INTO tasks (title, notes) VALUES (?, ?)");
  const ids: number[] = [];
  db.transaction(() => {
    for (const item of items) {
      const title = item.title.trim();
      if (title) ids.push(Number(insert.run(title, item.notes?.trim() || null).lastInsertRowid));
    }
  })();
  return ids;
}

const UPDATABLE = [
  "title", "notes", "category", "pile", "priority", "rationale", "status", "agent",
  "summary", "deliverable", "verdict", "review_notes", "error",
] as const;
type Updatable = (typeof UPDATABLE)[number];

export function updateTask(db: Db, id: number, fields: Partial<Pick<TaskRow, Updatable>>): void {
  const keys = (Object.keys(fields) as Updatable[]).filter((k) => UPDATABLE.includes(k));
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE tasks SET ${set}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`).run({
    ...fields,
    id,
  });
}

export function logEvent(
  db: Db,
  e: { task_id?: number | null; agent: string; kind: EventRow["kind"]; message: string },
): void {
  db.prepare("INSERT INTO events (task_id, agent, kind, message) VALUES (?, ?, ?, ?)").run(
    e.task_id ?? null,
    e.agent,
    e.kind,
    e.message.slice(0, 500),
  );
}

/** Atomically take inbox tasks for triage so concurrent runs never grab the same one. */
export function claimInbox(db: Db): TaskRow[] {
  return db.transaction(() => {
    const rows = db.prepare("SELECT * FROM tasks WHERE status = 'inbox' ORDER BY id").all() as TaskRow[];
    if (rows.length) {
      db.prepare(
        `UPDATE tasks SET status = 'triaging', agent = 'triage', error = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status = 'inbox'`,
      ).run();
    }
    return rows;
  })();
}

export function hasInbox(db: Db): boolean {
  return !!db.prepare("SELECT 1 FROM tasks WHERE status = 'inbox' LIMIT 1").get();
}

export function countQueued(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'inbox'").get() as { n: number }).n;
}

/** After a restart nothing is really running: put interrupted tasks back in the inbox. */
export function recoverStuck(db: Db): number {
  return db
    .prepare(
      `UPDATE tasks SET status = 'inbox', agent = NULL
       WHERE status IN ('triaging', 'working', 'reviewing')`,
    )
    .run().changes;
}

/** Replace everything the agent produced for a task with a fresh attempt. Approved/rejected drafts stay as history. */
export function saveWork(db: Db, taskId: number, work: WorkerResult): void {
  db.transaction(() => {
    db.prepare("DELETE FROM steps WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM artifacts WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM outbox WHERE task_id = ? AND status = 'pending'").run(taskId);

    const step = db.prepare("INSERT INTO steps (task_id, text, position) VALUES (?, ?, ?)");
    work.your_steps.filter((s) => s.trim()).forEach((s, i) => step.run(taskId, s.trim(), i));

    const art = db.prepare("INSERT INTO artifacts (task_id, kind, title, body) VALUES (?, ?, ?, ?)");
    for (const a of work.artifacts) if (a.body.trim()) art.run(taskId, a.kind, a.title, a.body);

    // Drafts only ever enter as 'pending'. Nothing in this app sends them.
    const out = db.prepare(
      "INSERT INTO outbox (task_id, channel, recipient, subject, body) VALUES (?, ?, ?, ?, ?)",
    );
    for (const o of work.outbound) if (o.body.trim()) out.run(taskId, o.channel, o.recipient, o.subject, o.body);

    updateTask(db, taskId, { summary: work.summary, deliverable: work.deliverable });
  })();
}

export function addReview(db: Db, taskId: number, round: number, review: ReviewResult): void {
  db.prepare("INSERT INTO reviews (task_id, round, verdict, issues, notes) VALUES (?, ?, ?, ?, ?)").run(
    taskId,
    round,
    review.verdict,
    JSON.stringify(review.issues),
    review.notes,
  );
}

export function requeue(db: Db, id: number): boolean {
  return db.transaction(() => {
    const t = getTask(db, id);
    if (!t || ["triaging", "working", "reviewing"].includes(t.status)) return false;
    db.prepare("DELETE FROM steps WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM artifacts WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM outbox WHERE task_id = ? AND status = 'pending'").run(id);
    db.prepare("DELETE FROM reviews WHERE task_id = ?").run(id);
    updateTask(db, id, {
      status: "inbox", agent: null, pile: null, summary: null, deliverable: null,
      verdict: null, review_notes: null, error: null, rationale: null,
    });
    return true;
  })();
}

export function deleteTask(db: Db, id: number): boolean {
  const t = getTask(db, id);
  if (!t || ["triaging", "working", "reviewing"].includes(t.status)) return false;
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return true;
}

/** Only a pending draft can be decided, and only to approved or rejected. */
export function decideOutbox(db: Db, id: number, decision: "approved" | "rejected"): boolean {
  return (
    db
      .prepare(
        `UPDATE outbox SET status = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND status = 'pending'`,
      )
      .run(decision, id).changes === 1
  );
}

export function setStepDone(db: Db, id: number, done: boolean): boolean {
  return db.prepare("UPDATE steps SET done = ? WHERE id = ?").run(done ? 1 : 0, id).changes === 1;
}

// ------------------------------------------------------------------------- reads

export function getTask(db: Db, id: number): TaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
}

export type TaskCard = Omit<TaskRow, "deliverable"> & {
  steps_total: number;
  steps_done: number;
  pending_drafts: number;
};

export interface PendingDraft extends OutboxRow {
  task_title: string;
}

// shortcut: minutes saved are fixed guesses per pile, not measured; replace with a per-task estimate if it matters.
const MINUTES_SAVED = { agent: 30, together: 20, mine: 5 } as const;

export interface Stats {
  finishedThisWeek: number;
  minutesSavedToday: number;
  /** Percent of sorted tasks the agent finished or prepared (agent and together piles). Null until something is sorted. */
  delegationScore: number | null;
}

export function getStats(db: Db): Stats {
  const done = (db
    .prepare(
      // shortcut: updated_at also moves on later edits, so "this week" is approximate; add a done_at column if it matters.
      "SELECT COUNT(*) AS n FROM tasks WHERE status = 'done' AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')",
    )
    .get() as { n: number }).n;

  const today = db
    .prepare(
      `SELECT pile, COUNT(*) AS n FROM tasks
       WHERE status IN ('ready','done') AND pile IS NOT NULL AND date(updated_at) = date('now')
       GROUP BY pile`,
    )
    .all() as { pile: keyof typeof MINUTES_SAVED; n: number }[];
  const minutesSavedToday = today.reduce((sum, r) => sum + r.n * MINUTES_SAVED[r.pile], 0);

  const score = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(pile IN ('agent','together') AND status IN ('ready','done')) AS handled
       FROM tasks WHERE pile IS NOT NULL`,
    )
    .get() as { total: number; handled: number | null };

  return {
    finishedThisWeek: done,
    minutesSavedToday,
    delegationScore: score.total ? Math.round(((score.handled ?? 0) / score.total) * 100) : null,
  };
}

export function getState(db: Db) {
  const tasks = db
    .prepare(
      `SELECT t.id, t.title, t.notes, t.category, t.pile, t.priority, t.rationale, t.status, t.agent,
              t.summary, t.verdict, t.review_notes, t.error, t.created_at, t.updated_at,
              (SELECT COUNT(*) FROM steps s WHERE s.task_id = t.id) AS steps_total,
              (SELECT COUNT(*) FROM steps s WHERE s.task_id = t.id AND s.done = 1) AS steps_done,
              (SELECT COUNT(*) FROM outbox o WHERE o.task_id = t.id AND o.status = 'pending') AS pending_drafts
       FROM tasks t
       ORDER BY (t.status = 'done'), t.priority, t.id`,
    )
    .all() as TaskCard[];

  const events = db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 40").all() as EventRow[];
  const approvals = db
    .prepare(
      `SELECT o.*, t.title AS task_title FROM outbox o JOIN tasks t ON t.id = o.task_id
       WHERE o.status = 'pending' ORDER BY o.id`,
    )
    .all() as PendingDraft[];

  // Approved drafts, newest first: these are waiting for the person to copy and send them.
  const cleared = db
    .prepare(
      `SELECT o.*, t.title AS task_title FROM outbox o JOIN tasks t ON t.id = o.task_id
       WHERE o.status = 'approved' ORDER BY o.decided_at DESC, o.id DESC LIMIT 20`,
    )
    .all() as PendingDraft[];

  const review = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(verdict = 'pass') AS passed, SUM(verdict = 'revise') AS revised,
              SUM(verdict = 'flag') AS flagged FROM reviews`,
    )
    .get() as { total: number; passed: number | null; revised: number | null; flagged: number | null };

  return {
    tasks,
    events,
    approvals,
    cleared,
    stats: getStats(db),
    review: {
      total: review.total,
      passed: review.passed ?? 0,
      revised: review.revised ?? 0,
      flagged: review.flagged ?? 0,
    },
  };
}

export function getDetail(db: Db, id: number) {
  const task = getTask(db, id);
  if (!task) return undefined;
  return {
    task,
    steps: db.prepare("SELECT * FROM steps WHERE task_id = ? ORDER BY position, id").all(id) as StepRow[],
    artifacts: db.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY id").all(id) as ArtifactRow[],
    drafts: db.prepare("SELECT * FROM outbox WHERE task_id = ? ORDER BY id").all(id) as OutboxRow[],
    reviews: db.prepare("SELECT * FROM reviews WHERE task_id = ? ORDER BY id").all(id) as ReviewRow[],
    events: db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 20").all(id) as EventRow[],
  };
}
