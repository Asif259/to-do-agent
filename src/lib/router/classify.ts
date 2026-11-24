/**
 * What to do after a failed upstream call. Pure functions: no I/O, easy to test.
 *
 *   429                       cool the model down (Retry-After, else daily quota to UTC midnight, else 60 s)
 *   401, 402                  disable the whole key
 *   403, 404                  disable just that model
 *   408, 5xx, timeout, reset  cool the model down 30 s
 *   other 4xx                 the request is at fault: report it, change nothing
 */
export type Action = "cooldown" | "disable_key" | "disable_model" | "passthrough";

export interface Failure {
  action: Action;
  reason: string;
  /** ISO time for cooldowns. */
  until?: string;
}

const SHORT_MS = 30_000;
const RATE_LIMIT_MS = 60_000;
const DAILY = /per[\s_-]?day|daily|\bRPD\b|\bTPD\b/i;

export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Retry-After is delta-seconds or an HTTP date. Never earlier than one second from now. */
export function parseRetryAfter(value: string | null, now: Date): Date | null {
  if (!value?.trim()) return null;
  const v = value.trim();
  const secs = Number(v);
  if (Number.isFinite(secs)) return new Date(now.getTime() + Math.max(secs, 1) * 1000);
  const date = Date.parse(v);
  return Number.isNaN(date) ? null : new Date(Math.max(date, now.getTime() + 1000));
}

const snippet = (body: string, limit = 160) => {
  const text = body.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

export function classifyResponse(status: number, retryAfter: string | null, body: string, now: Date): Failure {
  const detail = snippet(body);
  const reason = `HTTP ${status}${detail ? `: ${detail}` : ""}`;

  if (status === 429) {
    const until =
      parseRetryAfter(retryAfter, now) ??
      (DAILY.test(body) ? nextUtcMidnight(now) : new Date(now.getTime() + RATE_LIMIT_MS));
    return { action: "cooldown", reason, until: until.toISOString() };
  }
  if (status === 401 || status === 402) return { action: "disable_key", reason };
  if (status === 403 || status === 404) return { action: "disable_model", reason };
  if (status === 408 || status >= 500) {
    return { action: "cooldown", reason, until: new Date(now.getTime() + SHORT_MS).toISOString() };
  }
  return { action: "passthrough", reason };
}

export function classifyException(err: unknown, now: Date): Failure {
  const name = err instanceof Error ? err.name : "";
  const kind = name === "TimeoutError" || name === "AbortError" ? "timeout" : "connection error";
  return {
    action: "cooldown",
    reason: `${kind}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    until: new Date(now.getTime() + SHORT_MS).toISOString(),
  };
}

export function emptyReply(now: Date): Failure {
  return {
    action: "cooldown",
    reason: "The model returned an empty reply",
    until: new Date(now.getTime() + SHORT_MS).toISOString(),
  };
}
