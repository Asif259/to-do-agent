import { describe, expect, it } from "vitest";
import { extractJson } from "../src/lib/json";
import { Serial } from "../src/lib/pool";
import { addTasks, decideOutbox, getState } from "../src/lib/store";
import { ReviewResultSchema, TriageResultSchema, WorkerResultSchema } from "../src/lib/types";
import { FakeLlm, setup, sleep } from "./helpers";

describe("approval gate", () => {
  function withDraft() {
    const { db } = setup(new FakeLlm({}));
    const [taskId] = addTasks(db, [{ title: "t" }]);
    const id = Number(
      db.prepare("INSERT INTO outbox (task_id, channel, body) VALUES (?, 'email', 'hi')").run(taskId).lastInsertRowid,
    );
    return { db, id };
  }

  it("drafts start pending and appear in the approvals queue", () => {
    const { db, id } = withDraft();
    expect(getState(db).approvals.map((a) => [a.id, a.status])).toEqual([[id, "pending"]]);
  });

  it("a draft can be decided exactly once", () => {
    const { db, id } = withDraft();
    expect(decideOutbox(db, id, "approved")).toBe(true);
    expect(decideOutbox(db, id, "rejected")).toBe(false);
    expect(decideOutbox(db, id, "approved")).toBe(false);
    expect(getState(db).approvals).toHaveLength(0);
  });

  it("the database refuses any 'sent' status: nothing can be marked as sent", () => {
    const { db, id } = withDraft();
    expect(() => db.prepare("UPDATE outbox SET status = 'sent' WHERE id = ?").run(id)).toThrow(/CHECK/);
  });
});

describe("extractJson", () => {
  it("reads fenced JSON", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("ignores chatter around the object", () => {
    expect(extractJson('Sure! Here it is: {"a":{"b":2}} hope that helps')).toEqual({ a: { b: 2 } });
  });
  it("handles braces inside strings", () => {
    expect(extractJson('{"a":"} not the end {"}')).toEqual({ a: "} not the end {" });
  });
  it("forgives trailing commas", () => {
    expect(extractJson('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
  });
  it("throws when there is no object or it never closes", () => {
    expect(() => extractJson("no json")).toThrow();
    expect(() => extractJson('{"a":1')).toThrow();
  });
});

describe("lenient schemas", () => {
  it("normalises casing and aliases in triage output", () => {
    const parsed = TriageResultSchema.parse({
      items: [{ id: "4", title: "Pay rent", category: "Finance", pile: "Only me", priority: "1", rationale: "x" }],
    });
    expect(parsed.items[0]).toMatchObject({ id: 4, category: "money", pile: "mine", priority: 1 });
  });
  it("rejects an unknown pile rather than guessing", () => {
    expect(TriageResultSchema.safeParse({ items: [{ id: 1, title: "x", category: "work", pile: "maybe" }] }).success).toBe(false);
  });
  it("fills worker defaults and tolerates object steps", () => {
    const w = WorkerResultSchema.parse({ your_steps: [{ text: "call" }, "email"], artifacts: [{ kind: "Script", body: "hi" }] });
    expect(w.your_steps).toEqual(["call", "email"]);
    expect(w.artifacts[0]).toMatchObject({ kind: "script", title: "Untitled" });
    expect(w.outbound).toEqual([]);
  });
  it("maps reviewer synonyms", () => {
    expect(ReviewResultSchema.parse({ verdict: "Approved" }).verdict).toBe("pass");
  });
});

describe("Serial", () => {
  it("runs jobs one at a time, in order, even after a failure", async () => {
    const serial = new Serial();
    const log: string[] = [];
    const job = (name: string, ms: number, fail = false) =>
      serial.run(async () => {
        log.push(`start ${name}`);
        await sleep(ms);
        log.push(`end ${name}`);
        if (fail) throw new Error(name);
      });
    const results = await Promise.allSettled([job("a", 20), job("b", 1, true), job("c", 1)]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});
