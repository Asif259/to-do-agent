import type { Db } from "../db";
import type { LlmMessage } from "../llm";
import { classifyException, classifyResponse, emptyReply, type Failure } from "./classify";
import { applyFailure, getStrategy, poolHealth, recordSuccess, selectCandidates } from "./engine";
import { label, RouterError, type Candidate } from "./types";

export interface CallOptions {
  role: string;
  messages: LlmMessage[];
  temperature?: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
  now?: () => Date;
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface CallResult {
  text: string;
  provider: string;
  model: string;
  attempts: number;
}

function log(db: Db, o: { role: string; cand?: Candidate; status: number; started: number; attempts: number; notes: string[] }) {
  db.prepare(
    `INSERT INTO llm_log (role, provider, model, key_label, status_code, latency_ms, attempts, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.role,
    o.cand?.provider_name ?? null,
    o.cand?.model_id ?? null,
    o.cand?.key_label ?? null,
    o.status,
    Date.now() - o.started,
    o.attempts,
    o.notes.join("; ").slice(0, 500) || null,
  );
  db.prepare("DELETE FROM llm_log WHERE id <= (SELECT MAX(id) FROM llm_log) - 500").run();
}

/**
 * Send one chat request through the pool. Tries eligible models in order, cooling down or
 * disabling the ones that fail, until one answers. Throws RouterError when none can.
 */
export async function routedComplete(db: Db, opts: CallOptions): Promise<CallResult> {
  const doFetch = opts.fetch ?? fetch;
  const clock = opts.now ?? (() => new Date());
  const maxAttempts = opts.maxAttempts ?? 20;
  const started = Date.now();
  const notes: string[] = [];
  const deadKeys = new Set<number>();
  let attempts = 0;

  for (const cand of selectCandidates(db, getStrategy(db), clock())) {
    if (deadKeys.has(cand.key_id)) continue;
    if (attempts >= maxAttempts) break;
    attempts++;

    let failure: Failure | undefined;
    try {
      const res = await doFetch(`${cand.base_url.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cand.key_value}` },
        body: JSON.stringify({ model: cand.model_id, messages: opts.messages, temperature: opts.temperature ?? 0.3 }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
      const body = await res.text();
      if (res.ok) {
        let text: string | undefined;
        try {
          text = (JSON.parse(body) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
        } catch {
          /* handled as an empty reply below */
        }
        if (text?.trim()) {
          recordSuccess(db, cand);
          log(db, { role: opts.role, cand, status: 200, started, attempts, notes });
          return { text, provider: cand.provider_name, model: cand.model_id, attempts };
        }
        failure = emptyReply(clock());
      } else {
        failure = classifyResponse(res.status, res.headers.get("retry-after"), body, clock());
        if (failure.action === "passthrough") {
          notes.push(`${label(cand)} → ${failure.reason}`);
          log(db, { role: opts.role, cand, status: res.status, started, attempts, notes });
          throw new RouterError(`The model rejected the request: ${failure.reason}`, 400);
        }
      }
    } catch (err) {
      if (err instanceof RouterError) throw err;
      failure = classifyException(err, clock());
    }

    notes.push(`${label(cand)} → ${failure.reason}`);
    applyFailure(db, cand, failure);
    if (failure.action === "disable_key") deadKeys.add(cand.key_id);
  }

  const health = poolHealth(db, clock());
  let message: string;
  if (health.total === 0) {
    message = "No models are configured. Open Model configuration, add an API key and sync its models.";
  } else if (attempts === 0 && health.usable === 0 && health.nextAvailable) {
    message = `Every model is cooling down. The first is available again at ${health.nextAvailable.slice(11, 16)} UTC.`;
  } else if (health.nextAvailable) {
    message = `All models failed. The earliest is available again at ${health.nextAvailable.slice(11, 16)} UTC. Last error: ${notes.at(-1) ?? "none"}`;
  } else {
    message = `No usable model is left. Check keys and models in Model configuration. Last error: ${notes.at(-1) ?? "none"}`;
  }
  log(db, { role: opts.role, status: 503, started, attempts, notes: notes.length ? notes : [message] });
  throw new RouterError(message, 503);
}
