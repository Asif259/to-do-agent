import { describe, expect, it } from "vitest";
import { processInbox } from "../src/lib/orchestrator";
import { addTasks, countQueued, getState } from "../src/lib/store";
import { FakeLlm, okWorker, passReviewer, prefixTriage, setup, statusOf } from "./helpers";

describe("queue and stats", () => {
  it("added tasks wait in the queue until work starts", () => {
    const llm = new FakeLlm({ triage: prefixTriage, worker: okWorker(), reviewer: passReviewer() });
    const { db } = setup(llm);
    addTasks(db, [{ title: "A:one" }, { title: "T:two" }]);
    expect(countQueued(db)).toBe(2);
    expect(getState(db).tasks.every((t) => t.status === "inbox")).toBe(true);
    expect(llm.calls.triage).toHaveLength(0);
  });

  it("starting works every queued task and fills the stats", async () => {
    const llm = new FakeLlm({ triage: prefixTriage, worker: okWorker(), reviewer: passReviewer() });
    const { db, deps } = setup(llm);
    const ids = addTasks(db, [{ title: "A:one" }, { title: "T:two" }, { title: "M:three" }]);
    await processInbox(deps);
    expect(countQueued(db)).toBe(0);
    expect(ids.map((id) => statusOf(db, id)).every((s) => s === "ready" || s === "needs_you")).toBe(true);

    const { stats } = getState(db);
    expect(stats.delegationScore).toBeGreaterThanOrEqual(0);
    expect(stats.finishedThisWeek).toBe(0);

    db.prepare("UPDATE tasks SET status = 'done'").run();
    const after = getState(db).stats;
    expect(after.finishedThisWeek).toBe(3);
    expect(after.minutesSavedToday).toBe(30 + 20 + 5);
    expect(after.delegationScore).toBe(67);
  });

  it("score is null before anything is sorted", () => {
    const { db } = setup(new FakeLlm({}));
    expect(getState(db).stats.delegationScore).toBeNull();
  });
});
