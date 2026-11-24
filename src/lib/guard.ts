export interface GuardInput {
  method: string;
  /** Host header: what the browser typed, for example 192.168.1.20:3000. */
  host: string | null;
  origin: string | null;
  cookieToken: string | null;
  queryToken: string | null;
}

export type Guard = { action: "allow" } | { action: "login" } | { action: "deny"; status: 401 | 403; reason: string };

export const TOKEN_COOKIE = "todo_token";

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Pure access rules.
 * 1. Writes from another origin are refused, so a web page you visit cannot change your data.
 * 2. When ACCESS_TOKEN is set, every request needs it, via cookie or one-time ?token= link.
 */
export function guard(i: GuardInput, accessToken: string | undefined): Guard {
  if (WRITES.has(i.method) && i.origin) {
    let sameHost = false;
    try {
      sameHost = new URL(i.origin).host === i.host;
    } catch {
      // unparseable Origin stays refused
    }
    if (!sameHost) return { action: "deny", status: 403, reason: "Cross-site write refused." };
  }

  if (!accessToken) return { action: "allow" };
  if (i.cookieToken === accessToken) return { action: "allow" };
  if (i.queryToken === accessToken && i.method === "GET") return { action: "login" };
  return { action: "deny", status: 401, reason: "Access token required. Open the link with ?token=… once." };
}
