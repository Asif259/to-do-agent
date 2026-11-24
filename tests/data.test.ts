import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/lib/config";
import { openDb } from "../src/lib/db";
import { clearData, dataInfo, DataError, exportAll, importAll } from "../src/lib/data";
import { addKey } from "../src/lib/router/admin";
import { addTasks, getState, saveWork, updateTask } from "../src/lib/store";
import { decideOutbox } from "../src/lib/store";

function seeded() {
  const db = openDb(":memory:");
  const [id] = addTasks(db, [{ title: "t" }]);
  updateTask(db, id, { status: "ready", pile: "together" });
  saveWork(db, id, { summary: "s", deliverable: "d", your_steps: ["a"], artifacts: [], outbound: [{ channel: "email", recipient: "", subject: "", body: "hi" }] });
  addKey(db, { preset: "groq", label: "k", api_key: "gsk-1234567890" });
  db.prepare("INSERT INTO settings (key, value) VALUES ('strategy', 'round_robin')").run();
  return { db, id };
}

describe("your data", () => {
  it("reports what is stored", () => {
    const { db } = seeded();
    expect(dataInfo(db, ":memory:")).toMatchObject({ tasks: 1, drafts: 1, keys: 1, models: 0 });
  });

  it("clears tasks but keeps keys", () => {
    const { db } = seeded();
    clearData(db, "tasks");
    expect(dataInfo(db, ":memory:")).toMatchObject({ tasks: 0, drafts: 0, keys: 1 });
  });

  it("clears keys but keeps tasks, even while the agent is busy", () => {
    const { db, id } = seeded();
    updateTask(db, id, { status: "working" });
    clearData(db, "keys");
    expect(dataInfo(db, ":memory:")).toMatchObject({ tasks: 1, keys: 0 });
  });

  it("clears everything including settings", () => {
    const { db } = seeded();
    clearData(db, "all");
    expect(dataInfo(db, ":memory:")).toMatchObject({ tasks: 0, keys: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings").get()).toEqual({ n: 0 });
  });

  it("refuses to delete tasks while the agent is working", () => {
    const { db, id } = seeded();
    updateTask(db, id, { status: "reviewing" });
    expect(() => clearData(db, "tasks")).toThrow(DataError);
    expect(dataInfo(db, ":memory:").tasks).toBe(1);
  });
});

describe("cleared drafts", () => {
  it("lists approved drafts so they can be copied and sent", () => {
    const { db } = seeded();
    const draft = getState(db).approvals[0];
    expect(getState(db).cleared).toHaveLength(0);
    decideOutbox(db, draft.id, "approved");
    const state = getState(db);
    expect(state.approvals).toHaveLength(0);
    expect(state.cleared.map((d) => d.id)).toEqual([draft.id]);
  });
});

describe("default storage", () => {
  it("defaults config and openDb to in-memory database", () => {
    const cfg = loadConfig({});
    expect(cfg.dbFile).toBe(":memory:");
    const db = openDb();
    expect(db.memory).toBe(true);
    db.close();
  });

  it("exports and imports complete application state", () => {
    const { db: db1 } = seeded();
    const exported = exportAll(db1);
    expect(exported.tasks).toHaveLength(1);
    expect(exported.tasks[0].title).toBe("t");
    expect(exported.steps).toHaveLength(1);
    expect(exported.outbox).toHaveLength(1);
    expect(exported.llm_keys).toHaveLength(1);
    expect(exported.settings).toContainEqual({ key: "strategy", value: "round_robin" });

    const db2 = openDb(":memory:");
    importAll(db2, exported);
    const info = dataInfo(db2, ":memory:");
    expect(info.tasks).toBe(1);
    expect(info.drafts).toBe(1);
    expect(info.keys).toBe(1);
    expect(info.path).toBe("Browser Local Storage (localhost)");
    expect(info.bytes).toBeGreaterThan(0);

    const state = getState(db2);
    expect(state.tasks[0].title).toBe("t");
    expect(state.approvals[0].body).toBe("hi");
  });
});
