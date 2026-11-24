# Browser Storage & Localhost Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store all task and configuration data in browser `localStorage` (with localhost cookie sync) rather than creating a `data/` folder on disk, using an in-memory SQLite backend.

**Architecture:** Default the SQLite backend to `:memory:` so no files are written to disk. Expose export and import sync endpoints on `/api/data/sync`. The browser client automatically hydrates the server on initial load from `localStorage` if empty, and synchronizes state updates back to `localStorage` (with a cookie sync marker) as tasks and configurations change.

**Tech Stack:** Next.js (App Router, React 19), TypeScript, `better-sqlite3`, browser `localStorage` and `document.cookie`.

**Spec:** [`docs/superpowers/specs/2026-11-24-browser-storage-sync-design.md`](file:///Users/ashrafulasif/My%20projects/to-do-agent/docs/superpowers/specs/2026-11-24-browser-storage-sync-design.md)

## Global Constraints

- Do not create or write to a `data/` directory.
- `better-sqlite3` must run in `:memory:` mode when `TODO_DB` is not explicitly set.
- All 64 existing unit/integration tests must continue to pass without regression.
- Browser `localStorage` key is `todo_agent_storage`; sync cookie is `todo_storage_sync`.

## Review Focus

1. **Empty initial state with no localStorage**: A fresh browser load without existing localStorage must display the normal empty onboarding state without sync errors.
2. **Server restart hydration**: After a server restart (clearing `:memory:`), loading the browser must seamlessly restore all tasks, drafts, steps, reviews, and API keys from `localStorage`.
3. **Data clearing synchronization**: Clicking "Clear all tasks", "Remove all API keys", or "Delete everything" in `DataDrawer` must clear both server memory and browser `localStorage`.
4. **Draft and step integrity**: Complex tasks with steps, artifacts, outbox items, and reviewer notes must serialize and deserialize completely without loss of relational integrity.
5. **Disk cleanliness**: Verify that no `data/` folder exists and running the app/tests does not recreate `data/todo.db`.

---

### Task 1: Switch Default Database to In-Memory and Clean Up `data/` Folder

**Files:**
- Modify: `src/lib/config.ts:8-16`
- Modify: `src/lib/db.ts:131-138`
- Modify: `.env.example:9-11`
- Modify: `.env.local:9-10`
- Modify: `.gitignore:1-15`
- Delete: `data/` directory and any `todo.db*` files

**Interfaces:**
- Consumes: `process.env.TODO_DB`
- Produces: `Config.dbFile` defaulting to `":memory:"`, `openDb(file)` defaulting to `":memory:"`

- [ ] **Step 1: Write the failing test for default in-memory configuration**

In `tests/data.test.ts`, add test:
```ts
it("defaults config and openDb to in-memory database", () => {
  const cfg = loadConfig({});
  expect(cfg.dbFile).toBe(":memory:");
  const db = openDb();
  expect(db.memory).toBe(true);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/data.test.ts`
Expected: FAIL because `loadConfig` currently defaults to `"data/todo.db"`.

- [ ] **Step 3: Update `src/lib/config.ts` and `src/lib/db.ts` to default to `":memory:"`**

In `src/lib/config.ts`:
```ts
dbFile: env.TODO_DB?.trim() || ":memory:",
```
In `src/lib/db.ts`:
```ts
export function openDb(file: string = process.env.TODO_DB || ":memory:"): Db {
```
And remove `data/` directory and update `.env.local` (`# TODO_DB=:memory:`), `.env.example`, `.gitignore`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/data.test.ts`
Expected: PASS

- [ ] **Step 5: Verify all existing tests pass**

Run: `npm test`
Expected: PASS (all tests pass)

---

### Task 2: Implement Database Export and Import Serialization

**Files:**
- Modify: `src/lib/data.ts`
- Test: `tests/data.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/lib/db.ts`
- Produces:
  - `exportAll(db: Db): ExportData`
  - `importAll(db: Db, data: ExportData): void`
  - Updated `dataInfo(db: Db, file: string)` showing `"Browser Local Storage (localhost)"` when file is `":memory:"`.

- [ ] **Step 1: Write failing tests for `exportAll` and `importAll`**

In `tests/data.test.ts`:
```ts
it("exports and imports complete application state", () => {
  const db1 = openDb(":memory:");
  addTasks(db1, [{ title: "Task 1", notes: "Note 1" }]);
  const exported = exportAll(db1);
  expect(exported.tasks).toHaveLength(1);
  expect(exported.tasks[0].title).toBe("Task 1");

  const db2 = openDb(":memory:");
  importAll(db2, exported);
  const state = getState(db2);
  expect(state.tasks).toHaveLength(1);
  expect(state.tasks[0].title).toBe("Task 1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/data.test.ts`
Expected: FAIL (`exportAll` is not defined).

- [ ] **Step 3: Implement `exportAll` and `importAll` in `src/lib/data.ts`**

Implement:
- `exportAll`: Queries all tables (`tasks`, `steps`, `artifacts`, `outbox`, `reviews`, `events`, `llm_providers`, `llm_keys`, `llm_models`, `settings`) and formats them into an `ExportData` object.
- `importAll`: In a `db.transaction`, clears existing tables and batch inserts the imported rows with preservation of IDs and references.
- Update `dataInfo`: If `file === ":memory:"`, return `path: "Browser Local Storage (localhost)"` and calculate JSON export byte size for `bytes`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/data.test.ts`
Expected: PASS

---

### Task 3: Create Sync API Route (`/api/data/sync`) and Client Helpers

**Files:**
- Create: `src/app/api/data/sync/route.ts`
- Modify: `src/lib/client.ts`

**Interfaces:**
- Consumes: `exportAll`, `importAll` from `src/lib/data.ts`, `getDeps` from `src/lib/runtime.ts`
- Produces:
  - HTTP `GET /api/data/sync`: returns JSON `ExportData`
  - HTTP `POST /api/data/sync`: receives JSON `ExportData`, imports into database, returns `{ ok: true }`
  - `dataApi.export()` and `dataApi.import(data)` in `src/lib/client.ts`

- [ ] **Step 1: Implement `src/app/api/data/sync/route.ts`**

Export:
- `export const dynamic = "force-dynamic";`
- `GET()`: calls `exportAll(db)`, returns `NextResponse.json(exported)`
- `POST(req)`: parses body, calls `importAll(db, body)`, returns `NextResponse.json({ ok: true })`

- [ ] **Step 2: Add client methods to `dataApi` in `src/lib/client.ts`**

Add `export` and `import` functions:
```ts
export: () => fetch("/api/data/sync", { cache: "no-store" }).then((r) => r.json() as Promise<ExportData>),
import: (data: ExportData) => send<{ ok: boolean }>("POST", "/api/data/sync", data),
```

- [ ] **Step 3: Verify build and type checking**

Run: `npm run typecheck`
Expected: PASS

---

### Task 4: Integrate Client-Side Hydration and Synchronization into Dashboard

**Files:**
- Modify: `src/components/Dashboard.tsx`

**Interfaces:**
- Consumes: `dataApi.export()`, `dataApi.import(data)`, `localStorage`, `document.cookie`
- Produces: Seamless auto-restore from `localStorage` on initial load and auto-save on state updates.

- [ ] **Step 1: Implement hydration check on mount**

In `Dashboard.tsx`:
- On initial mount, fetch `/api/state`. If `state.tasks.length === 0` and `localStorage.getItem("todo_agent_storage")` contains saved data:
  - Call `dataApi.import(savedData)`
  - Re-fetch `/api/state` and `/api/health` so the UI immediately populates with the restored data.

- [ ] **Step 2: Implement auto-persistence on state change**

In `Dashboard.tsx`:
- When state loads or changes (and is not an empty reset state overriding existing data), debounce export via `dataApi.export()`, save to `localStorage.setItem("todo_agent_storage", JSON.stringify(exportData))`, and set cookie `document.cookie = "todo_storage_sync=" + Date.now() + "; path=/; max-age=31536000"`.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

---

### Task 5: Update `DataDrawer` and Documentation

**Files:**
- Modify: `src/components/DataDrawer.tsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: `dataApi.clear`, `localStorage`
- Produces: Accurate copy explaining browser storage on localhost, and clears `localStorage` when user triggers clear actions.

- [ ] **Step 1: Update `DataDrawer.tsx`**

- Update copy from "saved in one database file on this computer. It is not in your browser..." to:
  "Everything is saved in your browser storage (`localStorage`) on localhost. Nothing is stored in a disk folder. Clearing your browser storage or using the actions below resets your data."
- In `clear(a)` handler:
  - If `a.scope === "all"`: remove `localStorage.removeItem("todo_agent_storage")` and clear `todo_storage_sync` cookie.
  - If `a.scope === "tasks"` or `a.scope === "keys"`: re-sync export back to `localStorage` after clearing.

- [ ] **Step 2: Update `README.md`**

Update the "Where your data is saved" section to document the browser `localStorage` and localhost cookie model with in-memory execution, noting that no `data/` folder is created.

- [ ] **Step 3: Run full verification suite**

Run: `npm test && npm run typecheck && npm run build`
Expected: All tests pass, types pass, Next.js production build succeeds.
Verify `ls -d data` returns not found (no `data/` folder exists).
