import type { Config } from "../config";
import type { Db } from "../db";
import type { AgentRole } from "../types";
import { MockLlm } from "./mock";
import { RoutedLlm } from "./routed";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  role: AgentRole;
  messages: LlmMessage[];
}

/** One text-in, text-out call. Agents never see transport details. */
export interface Llm {
  complete(req: LlmRequest): Promise<string>;
}

export function createLlm(config: Config, db: Db): Llm {
  return config.mode === "mock" ? new MockLlm() : new RoutedLlm(db);
}
