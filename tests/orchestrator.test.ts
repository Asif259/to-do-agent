import { describe, expect, it } from "vitest";
import { processInbox } from "../src/lib/orchestrator";
import { addTasks, getDetail, getState, hasInbox, recoverStuck, requeue } from "../src/lib/store";
import { FakeLlm, okWorker, passReviewer, prefixTriage, setup, statusOf, tagged } from "./helpers";

const titles = ["A:one", "A:two", "T:three", "T:four", "M:five", "M:six"];

describe("pipeline", () => {
  it("sorts into piles, works in parallel under the cap, and reviews one at a time", async () => {
    const llm = new FakeLlm({ triage: prefixTriage, worker: okWorker(40), reviewer: passReviewer(10) });
    const { db, deps } = setup(llm);
    const ids = addTasks(db, titles.map((title) => ({ title })));

    await processInbox(deps);

    expect(llm.maxInFlight.worker).toBeGreaterThan(1); // really parallel
    expect(llm.maxInFlight.worker).toBeLessThanOrEqual(3); // capped
    expect(llm.maxInFlight.reviewer).toBe(1); // one reviewer
    expect(llm.calls.triage).toHaveLength(1); // one batched call

    const status = ids.map((id) => statusOf(db, id));
    expect(status).toEqual(["ready", "ready", "needs_you", "needs_you", "needs_you", "needs_you"]);
    const piles = db.prepare("SELECT pile FROM tasks ORDER BY id").all().map((r) => (r as { pile: string }).pile);
    expect(piles).toEqual(["agent", "agent", "together", "together", "mine", "mine"]);

    const detail = getDetail(db, ids[2])!;
    expect(detail.drafts).toHaveLength(1);
    expect(detail.drafts[0].status).toBe("pending");
    expect(detail.steps.map((s) => s.text)).toEqual(["do the thing"]);
    expect(getDetail(db, ids[4])!.artifacts[0].kind).toBe("reminder");
    expect(db.prepare("SELECT COUNT(*) c FROM reviews").get()).toEqual({ c: 6 });
  });

  it("two overlapping runs still share one worker cap and one reviewer", async () => {
    const llm = new FakeLlm({ triage: prefixTriage, worker: okWorker(40), reviewer: passReviewer(10) });
    const { db, deps } = setup(llm);
    addTasks(db, titles.map((title) => ({ title })));
    const first = processInbox(deps);
    await new Promise((r) => setTimeout(r, 5));
    addTasks(db, titles.map((title) => ({ title: title.replace(":", ":x") })));
    await Promise.all([first, processInbox(deps)]);

    expect(llm.maxInFlight.worker).toBeLessThanOrEqual(3);
    expect(llm.maxInFlight.reviewer).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM tasks WHERE status IN ('ready','needs_you')").get()).toEqual({ c: 12 });
    expect(hasInbox(db)).toBe(false);
  });

  it("frees a worker lane as soon as its work is saved, so review does not block the next task", async () => {
    let secondWorkerStarted!: () => void;
    const gate = new Promise<void>((resolve) => (secondWorkerStarted = resolve));
    const llm = new FakeLlm({
      triage: prefixTriage,
      worker: (req, n) => {
        if (n === 1) secondWorkerStarted();
        return okWorker(1)(req, n);
      },
      reviewer: async (_req, n) => {
        // The first review cannot finish until a second worker has started. If the single
        // worker lane were still held by task 1, that would never happen and this would time out.
        if (n === 0) {
          await Promise.race([
            gate,
            new Promise((_, reject) => setTimeout(() => reject(new Error("lane held during review")), 1500)),
          ]);
        }
        return JSON.stringify({ verdict: "pass", issues: [], notes: "ok" });
      },
    });
    const { db, deps } = setup(llm, { workerConcurrency: 1 });
    const ids = addTasks(db, [{ title: "A:one" }, { title: "A:two" }]);

    await processInbox(deps);

    expect(ids.map((id) => statusOf(db, id))).toEqual(["ready", "ready"]);
  });

  it("does nothing when the inbox is empty", async () => {
    const llm = new FakeLlm({});
    const { deps } = setup(llm);
    expect(await processInbox(deps)).toBe(0);
    expect(llm.calls.triage).toHaveLength(0);
  });
});

describe("review loop", () => {
  it("sends reviewer feedback back to the worker once, then passes", async () => {
    let reviews = 0;
    const llm = new FakeLlm({
      triage: prefixTriage,
      worker: okWorker(1),
      reviewer: () => {
        reviews++;
        return JSON.stringify(
          reviews === 1
            ? { verdict: "revise", issues: ["invented a price"], notes: "" }
            : { verdict: "pass", issues: [], notes: "fixed" },
        );
      },
    });
    const { db, deps } = setup(llm);
    const [id] = addTasks(db, [{ title: "A:compare plans" }]);

    await processInbox(deps);

    expect(llm.calls.worker).toHaveLength(2);
    const retry = llm.calls.worker[1].messages.at(-1)!.content;
    expect(retry).toContain("<feedback>");
    expect(retry).toContain("invented a price");
    expect(statusOf(db, id)).toBe("ready");
    expect(getDetail(db, id)!.reviews.map((r) => r.verdict)).toEqual(["revise", "pass"]);
  });

  it("flags the task when issues remain after the revision", async () => {
    const llm = new FakeLlm({
      triage: prefixTriage,
      worker: okWorker(1),
      reviewer: () => JSON.stringify({ verdict: "revise", issues: ["still wrong"], notes: "" }),
    });
    const { db, deps } = setup(llm);
    const [id] = addTasks(db, [{ title: "A:x" }]);

    await processInbox(deps);

    expect(llm.calls.worker).toHaveLength(2);
    const row = db.prepare("SELECT status, verdict, review_notes FROM tasks WHERE id = ?").get(id) as Record<string, string>;
    expect(row.status).toBe("needs_you");
    expect(row.verdict).toBe("flag");
    expect(row.review_notes).toContain("still wrong");
  });

  it("an agent-pile task the reviewer flags needs you, not ready", async () => {
    const llm = new FakeLlm({
      triage: prefixTriage,
      worker: okWorker(1),
      reviewer: () => JSON.stringify({ verdict: "flag", issues: [], notes: "ambiguous task" }),
    });
    const { db, deps } = setup(llm);
    const [id] = addTasks(db, [{ title: "A:x" }]);
    await processInbox(deps);
    expect(statusOf(db, id)).toBe("needs_you");
  });

  it("never passes work unchecked when the reviewer is down", async () => {
    const llm = new FakeLlm({
      triage: prefixTriage,
      worker: okWorker(1),
      reviewer: () => {
        throw new Error("router down");
      },
    });
    const { db, deps } = setup(llm);
    const [id] = addTasks(db, [{ title: "A:x" }]);
    await processInbox(deps);
    const row = db.prepare("SELECT status, verdict, review_notes FROM tasks WHERE id = ?").get(id) as Record<string, string>;
    expect(row.status).toBe("needs_you");
    expect(row.verdict).toBe("flag");
    expect(row.review_notes).toContain("Not independently checked");
  });
});

describe("failures stay contained", () => {
  it("one failing worker does not stop the others", async () => {
    const llm = new FakeLlm({
      triage: prefixTriage,
      worker: (req, n) => {
        if (tagged<{ title: string }>(req, "task").title === "boom") throw new Error("model exploded");
        return okWorker(1)(req, n);
      },
      reviewer: passReviewer(1),
    });
    const { db, deps } = setup(llm);
    const ids = addTasks(db, [{ title: "A:ok1" }, { title: "A:boom" }, { title: "A:ok2" }]);

    await processInbox(deps);

    expect(ids.map((id) => statusOf(db, id))).toEqual(["ready", "failed", "ready"]);
    const failed = db.prepare("SELECT error FROM tasks WHERE id = ?").get(ids[1]) as { error: string };
    expect(failed.error).toContain("model exploded");
  });

  it("retries malformed triage JSON once, with the model shown its mistake", async () => {
    const llm = new FakeLlm({
      triage: (req, n) => (n === 0 ? "Sure! here you go: {not json" : prefixTriage(req, n)),
      worker: okWorker(1),
      reviewer: passReviewer(1),
    });
    const { db, deps } = setup(llm);
    const [id] = addTasks(db, [{ title: "A:x" }]);
    await processInbox(deps);
    expect(llm.calls.triage).toHaveLength(2);
    expect(llm.calls.triage[1].messages.at(-1)!.content).toContain("not usable");
    expect(statusOf(db, id)).toBe("ready");
  });

  it("marks tasks failed (not stuck, not looping) when triage never works", async () => {
    const llm = new FakeLlm({ triage: () => "nope" });
    const { db, deps } = setup(llm);
    const ids = addTasks(db, [{ title: "A:x" }, { title: "A:y" }]);
    await processInbox(deps);
    expect(ids.map((id) => statusOf(db, id))).toEqual(["failed", "failed"]);
    expect(hasInbox(db)).toBe(false);
  });

  it("defaults an item triage skipped to Together", async () => {
    const llm = new FakeLlm({
      triage: (req) => {
        const [first] = tagged<{ id: number; title: string }[]>(req, "tasks");
        return JSON.stringify({ items: [{ id: first.id, title: "kept", category: "work", pile: "agent", priority: 1, rationale: "" }] });
      },
      worker: okWorker(1),
      reviewer: passReviewer(1),
    });
    const { db, deps } = setup(llm);
    const [a, b] = addTasks(db, [{ title: "one" }, { title: "two" }]);
    await processInbox(deps);
    const piles = [a, b].map((id) => (db.prepare("SELECT pile FROM tasks WHERE id = ?").get(id) as { pile: string }).pile);
    expect(piles).toEqual(["agent", "together"]);
  });
});

describe("state helpers", () => {
  it("recoverStuck puts interrupted tasks back in the inbox", () => {
    const { db } = setup(new FakeLlm({}));
    const ids = addTasks(db, [{ title: "a" }, { title: "b" }, { title: "c" }]);
    db.prepare("UPDATE tasks SET status = 'working' WHERE id = ?").run(ids[0]);
    db.prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(ids[1]);
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(ids[2]);
    expect(recoverStuck(db)).toBe(2);
    expect(ids.map((id) => statusOf(db, id))).toEqual(["inbox", "inbox", "done"]);
  });

  it("requeue clears the agent's output but keeps decided drafts", async () => {
    const llm = new FakeLlm({ triage: prefixTriage, worker: okWorker(1), reviewer: passReviewer(1) });
    const { db, deps } = setup(llm);
    const [id] = addTasks(db, [{ title: "T:send it" }]);
    await processInbox(deps);
    db.prepare("INSERT INTO outbox (task_id, channel, body, status) VALUES (?, 'email', 'old', 'approved')").run(id);

    expect(requeue(db, id)).toBe(true);

    const detail = getDetail(db, id)!;
    expect(detail.task.status).toBe("inbox");
    expect(detail.steps).toHaveLength(0);
    expect(detail.reviews).toHaveLength(0);
    expect(detail.drafts.map((d) => d.status)).toEqual(["approved"]);
    expect(getState(db).approvals).toHaveLength(0);
  });
});
