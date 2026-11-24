import { loadConfig } from "../src/lib/config";
import { openDb, type Db } from "../src/lib/db";
import type { Llm, LlmRequest } from "../src/lib/llm";
import { createDeps, type Deps } from "../src/lib/orchestrator";
import type { AgentRole } from "../src/lib/types";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function tagged<T>(req: LlmRequest, tag: string): T {
  const content = req.messages.map((m) => m.content).join("\n");
  const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) throw new Error(`no <${tag}> in request`);
  return JSON.parse(m[1]) as T;
}

type Handler = (req: LlmRequest, nth: number) => string | Promise<string>;

/** Scripted model. Tracks how many calls per role are in flight at once. */
export class FakeLlm implements Llm {
  calls: Record<AgentRole, LlmRequest[]> = { triage: [], worker: [], reviewer: [] };
  inFlight: Record<AgentRole, number> = { triage: 0, worker: 0, reviewer: 0 };
  maxInFlight: Record<AgentRole, number> = { triage: 0, worker: 0, reviewer: 0 };

  constructor(private readonly handlers: Partial<Record<AgentRole, Handler>>) {}

  async complete(req: LlmRequest): Promise<string> {
    const { role } = req;
    const nth = this.calls[role].push(req) - 1;
    this.inFlight[role]++;
    this.maxInFlight[role] = Math.max(this.maxInFlight[role], this.inFlight[role]);
    try {
      const handler = this.handlers[role];
      if (!handler) throw new Error(`no handler for ${role}`);
      return await handler(req, nth);
    } finally {
      this.inFlight[role]--;
    }
  }
}

/** Title prefix picks the pile: "A:" agent, "T:" together, "M:" mine. */
export const prefixTriage: Handler = (req) => {
  const tasks = tagged<{ id: number; title: string }[]>(req, "tasks");
  const pile = { A: "agent", T: "together", M: "mine" } as const;
  return JSON.stringify({
    items: tasks.map((t) => ({
      id: t.id,
      title: t.title.slice(2),
      category: "work",
      pile: pile[t.title[0] as keyof typeof pile],
      priority: 2,
      rationale: "test",
    })),
  });
};

export const okWorker =
  (delayMs = 20): Handler =>
  async (req) => {
    await sleep(delayMs);
    const task = tagged<{ title: string; pile: string }>(req, "task");
    return JSON.stringify({
      summary: `did ${task.title}`,
      deliverable: `## ${task.title}`,
      your_steps: task.pile === "agent" ? [] : ["do the thing"],
      artifacts: task.pile === "mine" ? [{ kind: "reminder", title: "r", body: "remember" }] : [],
      outbound: task.pile === "together" ? [{ channel: "email", recipient: "a@b.c", subject: "s", body: "hello" }] : [],
    });
  };

export const passReviewer =
  (delayMs = 5): Handler =>
  async () => {
    await sleep(delayMs);
    return JSON.stringify({ verdict: "pass", issues: [], notes: "ok" });
  };

export function setup(llm: Llm, overrides: Partial<ReturnType<typeof loadConfig>> = {}): { db: Db; deps: Deps } {
  const config = { ...loadConfig({}), workerConcurrency: 3, ...overrides };
  const db = openDb(":memory:");
  return { db, deps: createDeps(db, llm, config) };
}

export const statusOf = (db: Db, id: number) =>
  (db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status;
