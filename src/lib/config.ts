export interface Config {
  mode: "live" | "mock";
  workerConcurrency: number;
  maxRevisions: number;
  dbFile: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const concurrency = Number.parseInt(env.WORKER_CONCURRENCY ?? "", 10);
  return {
    mode: env.LLM_MODE === "mock" ? "mock" : "live",
    workerConcurrency: Number.isFinite(concurrency) && concurrency > 0 ? Math.min(concurrency, 8) : 3,
    maxRevisions: 1,
    dbFile: env.TODO_DB?.trim() || ":memory:",
  };
}
