import { loadConfig } from "./config";
import { openDb } from "./db";
import { createLlm } from "./llm";
import { createDeps, processInbox, type Deps } from "./orchestrator";
import { logEvent, recoverStuck } from "./store";

// One runtime per server process, shared across route handlers and dev-mode reloads.
const g = globalThis as typeof globalThis & { __todoDeps?: Deps };

export function getDeps(): Deps {
  if (!g.__todoDeps) {
    const config = loadConfig();
    const db = openDb(config.dbFile);
    const recovered = recoverStuck(db);
    g.__todoDeps = createDeps(db, createLlm(config, db), config);
    if (recovered) {
      logEvent(db, { agent: "system", kind: "info", message: `Restarted: ${recovered} interrupted task(s) re-queued.` });
    }
  }
  return g.__todoDeps;
}

/** Start working the inbox in the background. Returns immediately. */
export function kick(): void {
  const deps = getDeps();
  void processInbox(deps).catch((err) => {
    logEvent(deps.db, {
      agent: "system",
      kind: "error",
      message: `Run failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  });
}
