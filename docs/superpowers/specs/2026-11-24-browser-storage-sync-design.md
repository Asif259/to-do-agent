# Design Specification: Browser Storage & Localhost Sync

## 1. Intent and The Why
The user requested that data be stored in `localhost/cookies` (client-side browser storage like `localStorage`) rather than in the repository's `data/` folder on disk. This prevents writing SQLite database files (`todo.db`, `todo.db-wal`, `todo.db-shm`) to the filesystem, keeping the project directory clean and giving the user client-controlled persistence directly in their browser.

## 2. Goals, Non-Goals, and Anti-Goals
- **Goals**:
  - Eliminate the `data/` folder and prevent any SQLite files from being created on disk.
  - Default database mode to `:memory:` (RAM-only SQLite).
  - Automatically persist and restore application state (tasks, steps, artifacts, drafts, reviews, events, LLM keys, models, settings) in browser `localStorage`.
  - Maintain a localhost cookie (`todo_storage_sync`) indicating sync state and timestamp.
  - Update `DataDrawer` and documentation (`README.md`, `.env.example`, `.env.local`) to reflect that storage is kept in browser `localStorage`.
  - Ensure all clear operations in `DataDrawer` purge both the server in-memory database and browser `localStorage`.
- **Non-Goals**:
  - Rewriting the database or multi-agent orchestrator away from SQLite (in-memory SQLite remains the execution engine for ACID transactions, concurrency, and cascade deletes).
  - Cross-browser syncing (data stays in the specific browser used to access `localhost:3000`).
- **Anti-Goals**:
  - Breaking existing unit or integration tests.
  - Exceeding cookie size limits by stuffing large deliverables directly into HTTP cookies (cookies will only store lightweight metadata/sync indicators, while `localStorage` stores the full JSON data).

## 3. Approaches Considered
- **Approach 1 (Selected): In-Memory Server SQLite with Automatic Browser `localStorage` & Cookie Sync**:
  - Run SQLite in `:memory:`. Add export/import endpoints (`/api/data/sync` or `/api/data`).
  - Client hydrates in-memory DB from `localStorage` on initial load when server is empty, and saves snapshots back to `localStorage` on poll/updates.
  - Preserves 100% test compatibility, robust concurrency, and zero file writes.
- **Approach 2: Full Client-Side Store (Eliminate SQLite entirely)**:
  - Rip out `better-sqlite3`, rewrite store and orchestrator in plain JS objects.
  - Rejected: massive refactor risk, loses transactional safety, breaks existing tests.

## 4. Technical Architecture and Data Flow

### 4.1 Server-Side Database Configuration
- In `src/lib/config.ts`: default `dbFile` to `":memory:"` if `process.env.TODO_DB` is not set or set to `""`.
- In `src/lib/db.ts`: default `file` parameter to `process.env.TODO_DB || ":memory:"`.
- Remove existing `data/` directory and files.
- Ensure `.gitignore` ignores `data/` and `*.db*`.

### 4.2 Database Serialization (`src/lib/data.ts`)
- `exportAll(db: Db)`: Exports all table rows as a clean JSON structure:
  ```ts
  {
    tasks: TaskRow[],
    steps: StepRow[],
    artifacts: ArtifactRow[],
    outbox: OutboxRow[],
    reviews: ReviewRow[],
    events: EventRow[],
    llm_providers: LlmProviderRow[],
    llm_keys: LlmKeyRow[],
    llm_models: LlmModelRow[],
    settings: Record<string, string>,
    version: 1,
    exported_at: string
  }
  ```
- `importAll(db: Db, data: ExportData)`: Uses a transaction to clear existing tables and repopulate them from the imported data.

### 4.3 API Endpoints
- `GET /api/data/sync`: Returns `exportAll(db)`.
- `POST /api/data/sync`: Accepts JSON payload and runs `importAll(db, data)`.
- `GET /api/data`: Returns metadata including `storage: "localStorage"`, row counts, and approximate byte size.

### 4.4 Client-Side Hydration and Persistence (`src/components/Dashboard.tsx`)
- Key in `localStorage`: `todo_agent_storage`.
- On boot (`Dashboard.tsx` mount):
  1. Fetch `/api/state`.
  2. If the server has 0 tasks, 0 keys, and `localStorage.getItem("todo_agent_storage")` exists, call `POST /api/data/sync` with the saved payload.
  3. Reload state so the UI immediately reflects restored tasks.
- On polling / updates:
  1. When state changes or tasks finish, fetch `/api/data/sync` and write to `localStorage`.
  2. Update a cookie `todo_storage_sync` with the sync timestamp (`document.cookie = "todo_storage_sync=...; path=/; max-age=31536000"`).
- In `DataDrawer`:
  - Display storage location as "Browser Local Storage (localhost)".
  - Display stored tasks, drafts, keys, models, and byte size.
  - When clearing tasks/keys/all: remove item from `localStorage` and clear server state.

## 5. Verification Plan
- Automated:
  - Run `npm test` to verify all 64 existing unit/integration tests pass with `:memory:`.
  - Add tests in `tests/data.test.ts` for `exportAll` and `importAll`.
  - Run `npm run typecheck` and `npm run build`.
- Manual:
  - Add tasks and an API key.
  - Verify no `data/` folder is created on disk.
  - Verify `localStorage` contains `todo_agent_storage`.
  - Restart the dev server, reload browser, and verify tasks and keys are automatically restored.
