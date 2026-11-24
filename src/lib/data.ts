import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db";

export type ClearScope = "tasks" | "keys" | "all";

export class DataError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export interface ExportData {
  version: number;
  exported_at: string;
  tasks: any[];
  steps: any[];
  artifacts: any[];
  outbox: any[];
  reviews: any[];
  events: any[];
  llm_providers: any[];
  llm_keys: any[];
  llm_models: any[];
  settings: { key: string; value: string }[];
  llm_log?: any[];
}

export function exportAll(db: Db): ExportData {
  const all = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    tasks: all("tasks"),
    steps: all("steps"),
    artifacts: all("artifacts"),
    outbox: all("outbox"),
    reviews: all("reviews"),
    events: all("events"),
    llm_providers: all("llm_providers"),
    llm_keys: all("llm_keys"),
    llm_models: all("llm_models"),
    settings: db.prepare("SELECT key, value FROM settings ORDER BY key").all() as { key: string; value: string }[],
    llm_log: all("llm_log"),
  };
}

export function importAll(db: Db, data: Partial<ExportData>): void {
  db.transaction(() => {
    // Clear everything first
    db.prepare("DELETE FROM tasks").run();
    db.prepare("DELETE FROM events").run();
    db.prepare("DELETE FROM llm_providers").run();
    db.prepare("DELETE FROM llm_log").run();
    db.prepare("DELETE FROM settings").run();

    if (data.tasks?.length) {
      const ins = db.prepare(`
        INSERT INTO tasks (id, title, notes, category, pile, priority, rationale, status, agent, summary, deliverable, verdict, review_notes, error, created_at, updated_at)
        VALUES (@id, @title, @notes, @category, @pile, @priority, @rationale, @status, @agent, @summary, @deliverable, @verdict, @review_notes, @error, @created_at, @updated_at)
      `);
      for (const t of data.tasks) ins.run(t);
    }

    if (data.steps?.length) {
      const ins = db.prepare("INSERT INTO steps (id, task_id, text, done, position) VALUES (@id, @task_id, @text, @done, @position)");
      for (const s of data.steps) ins.run(s);
    }

    if (data.artifacts?.length) {
      const ins = db.prepare("INSERT INTO artifacts (id, task_id, kind, title, body, created_at) VALUES (@id, @task_id, @kind, @title, @body, @created_at)");
      for (const a of data.artifacts) ins.run(a);
    }

    if (data.outbox?.length) {
      const ins = db.prepare("INSERT INTO outbox (id, task_id, channel, recipient, subject, body, status, created_at, decided_at) VALUES (@id, @task_id, @channel, @recipient, @subject, @body, @status, @created_at, @decided_at)");
      for (const o of data.outbox) ins.run(o);
    }

    if (data.reviews?.length) {
      const ins = db.prepare("INSERT INTO reviews (id, task_id, round, verdict, issues, notes, created_at) VALUES (@id, @task_id, @round, @verdict, @issues, @notes, @created_at)");
      for (const r of data.reviews) ins.run(r);
    }

    if (data.events?.length) {
      const ins = db.prepare("INSERT INTO events (id, ts, task_id, agent, kind, message) VALUES (@id, @ts, @task_id, @agent, @kind, @message)");
      for (const e of data.events) ins.run(e);
    }

    if (data.llm_providers?.length) {
      const ins = db.prepare("INSERT INTO llm_providers (id, name, preset, base_url, free_only) VALUES (@id, @name, @preset, @base_url, @free_only)");
      for (const p of data.llm_providers) ins.run(p);
    }

    if (data.llm_keys?.length) {
      const ins = db.prepare("INSERT INTO llm_keys (id, provider_id, label, key_value, status, last_error) VALUES (@id, @provider_id, @label, @key_value, @status, @last_error)");
      for (const k of data.llm_keys) ins.run(k);
    }

    if (data.llm_models?.length) {
      const ins = db.prepare("INSERT INTO llm_models (id, key_id, model_id, enabled, priority, status, cooldown_until, last_error) VALUES (@id, @key_id, @model_id, @enabled, @priority, @status, @cooldown_until, @last_error)");
      for (const m of data.llm_models) ins.run(m);
    }

    if (data.settings?.length) {
      const ins = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (@key, @value)");
      for (const s of data.settings) ins.run(s);
    }

    if (data.llm_log?.length) {
      const ins = db.prepare("INSERT INTO llm_log (id, ts, role, provider, model, key_label, status_code, latency_ms, attempts, note) VALUES (@id, @ts, @role, @provider, @model, @key_label, @status_code, @latency_ms, @attempts, @note)");
      for (const l of data.llm_log) ins.run(l);
    }
  })();
}

/** Where everything is stored, and how much there is. */
export function dataInfo(db: Db, file: string) {
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  if (file === ":memory:") {
    const json = JSON.stringify(exportAll(db));
    return {
      path: "Browser Local Storage (localhost)",
      bytes: Buffer.byteLength(json, "utf8"),
      tasks: count("tasks"),
      drafts: count("outbox"),
      keys: count("llm_keys"),
      models: count("llm_models"),
    };
  }
  const abs = path.resolve(/* turbopackIgnore: true */ file);
  let bytes = 0;
  try {
    bytes = fs.statSync(abs).size;
  } catch {
    /* in-memory database */
  }
  return { path: abs, bytes, tasks: count("tasks"), drafts: count("outbox"), keys: count("llm_keys"), models: count("llm_models") };
}

/** Delete data from the database. Refuses while the agent is working, so nothing is half-deleted. */
export function clearData(db: Db, scope: ClearScope): void {
  if (scope !== "keys") {
    const busy = db.prepare("SELECT 1 FROM tasks WHERE status IN ('inbox','triaging','working','reviewing') LIMIT 1").get();
    if (busy) throw new DataError("The agent is still working. Wait for it to finish, then try again.");
  }
  db.transaction(() => {
    if (scope === "tasks" || scope === "all") {
      db.prepare("DELETE FROM tasks").run(); // steps, artifacts, drafts and reviews cascade
      db.prepare("DELETE FROM events").run();
    }
    if (scope === "keys" || scope === "all") {
      db.prepare("DELETE FROM llm_providers").run(); // keys and models cascade
      db.prepare("DELETE FROM llm_log").run();
    }
    if (scope === "all") db.prepare("DELETE FROM settings").run();
  })();
}
