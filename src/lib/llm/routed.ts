import type { Db } from "../db";
import { routedComplete } from "../router/call";
import type { Llm, LlmRequest } from "./index";

const TEMPERATURE = { triage: 0.2, worker: 0.5, reviewer: 0.1 } as const;

/** The agent's live model: every call goes through the router pool with failover. */
export class RoutedLlm implements Llm {
  constructor(
    private readonly db: Db,
    private readonly fetchFn?: typeof fetch,
  ) {}

  async complete({ role, messages }: LlmRequest): Promise<string> {
    const { text } = await routedComplete(this.db, {
      role,
      messages,
      temperature: TEMPERATURE[role],
      fetch: this.fetchFn,
    });
    return text;
  }
}
