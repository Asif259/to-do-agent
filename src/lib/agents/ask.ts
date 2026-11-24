import type { z } from "zod";
import { extractJson } from "../json";
import type { Llm, LlmMessage } from "../llm";
import type { AgentRole } from "../types";

function describe(err: unknown): string {
  if (err && typeof err === "object" && "issues" in err) {
    return (err as z.ZodError).issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ask the model for JSON and validate it. On a bad reply, show the model its own
 * mistake once and ask again. Transport errors are not retried here.
 */
export async function askJson<S extends z.ZodType>(
  llm: Llm,
  role: AgentRole,
  messages: LlmMessage[],
  schema: S,
  retries = 1,
): Promise<z.infer<S>> {
  const convo = [...messages];
  let lastProblem = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const reply = await llm.complete({ role, messages: convo });
    try {
      const parsed = schema.safeParse(extractJson(reply));
      if (parsed.success) return parsed.data;
      lastProblem = describe(parsed.error);
    } catch (err) {
      lastProblem = describe(err);
    }
    convo.push(
      { role: "assistant", content: reply },
      {
        role: "user",
        content: `That reply was not usable (${lastProblem}). Reply again with only the JSON object in the requested shape.`,
      },
    );
  }
  throw new Error(`The model did not return valid JSON after ${retries + 1} tries: ${lastProblem}`);
}
