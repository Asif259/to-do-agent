import type { Db } from "../db";
import type { Failure } from "./classify";
import type { Candidate, KeyRow, Strategy } from "./types";
import { STRATEGIES } from "./types";

export function getSetting(db: Db, key: string, fallback: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

export function getStrategy(db: Db): Strategy {
  const v = getSetting(db, "strategy", "waterfall") as Strategy;
  return STRATEGIES.includes(v) ? v : "waterfall";
}

const ELIGIBLE = `
  FROM llm_models m
  JOIN llm_keys k ON k.id = m.key_id
  JOIN llm_providers p ON p.id = k.provider_id
  WHERE m.enabled = 1 AND m.status != 'disabled' AND k.status = 'active'
    AND (m.cooldown_until IS NULL OR m.cooldown_until <= @now)`;

/** Eligible (key, model) pairs in the order they should be tried. */
export function selectCandidates(db: Db, strategy: Strategy, now = new Date()): Candidate[] {
  const order = strategy === "round_robin" ? "m.id" : "m.priority, m.id";
  const rows = db
    .prepare(
      `SELECT m.id, m.model_id, k.id AS key_id, k.label AS key_label, k.key_value,
              p.name AS provider_name, p.base_url ${ELIGIBLE} ORDER BY ${order}`,
    )
    .all({ now: now.toISOString() }) as Candidate[];

  if (strategy === "round_robin" && rows.length) {
    const cursor = Number.parseInt(getSetting(db, "rr_cursor", "0"), 10) || 0;
    setSetting(db, "rr_cursor", String(cursor + 1));
    const start = cursor % rows.length;
    return [...rows.slice(start), ...rows.slice(0, start)];
  }
  return rows;
}

/** Counts for the status chip: how many models can be called right now. */
export function poolHealth(db: Db, now = new Date()) {
  const iso = now.toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(m.enabled = 1 AND m.status != 'disabled' AND k.status = 'active'
                  AND (m.cooldown_until IS NULL OR m.cooldown_until <= @now)) AS usable,
              SUM(m.enabled = 1 AND m.status != 'disabled' AND k.status = 'active'
                  AND m.cooldown_until > @now) AS cooling,
              MIN(CASE WHEN m.enabled = 1 AND m.status != 'disabled' AND k.status = 'active'
                       AND m.cooldown_until > @now THEN m.cooldown_until END) AS next_available
       FROM llm_models m JOIN llm_keys k ON k.id = m.key_id`,
    )
    .get({ now: iso }) as { total: number; usable: number | null; cooling: number | null; next_available: string | null };
  return {
    total: row.total,
    usable: row.usable ?? 0,
    cooling: row.cooling ?? 0,
    nextAvailable: row.next_available,
  };
}

export function applyFailure(db: Db, cand: Candidate, failure: Failure): void {
  const note = failure.reason.slice(0, 300);
  if (failure.action === "cooldown") {
    db.prepare("UPDATE llm_models SET status = 'cooling_down', cooldown_until = ?, last_error = ? WHERE id = ?").run(
      failure.until ?? null,
      note,
      cand.id,
    );
  } else if (failure.action === "disable_model") {
    db.prepare("UPDATE llm_models SET status = 'disabled', cooldown_until = NULL, last_error = ? WHERE id = ?").run(note, cand.id);
  } else if (failure.action === "disable_key") {
    db.prepare("UPDATE llm_keys SET status = 'disabled', last_error = ? WHERE id = ?").run(note, cand.key_id);
    db.prepare("UPDATE llm_models SET last_error = ? WHERE id = ?").run(note, cand.id);
  }
}

export function recordSuccess(db: Db, cand: Candidate): void {
  db.prepare(
    `UPDATE llm_models SET status = 'active', cooldown_until = NULL, last_error = NULL
     WHERE id = ? AND (status != 'active' OR cooldown_until IS NOT NULL OR last_error IS NOT NULL)`,
  ).run(cand.id);
}

export function effectiveStatus(
  model: { status: string; cooldown_until: string | null },
  key: Pick<KeyRow, "status">,
  now = new Date(),
): "active" | "cooling_down" | "disabled" {
  if (key.status === "disabled" || model.status === "disabled") return "disabled";
  if (model.cooldown_until && model.cooldown_until > now.toISOString()) return "cooling_down";
  return "active";
}
