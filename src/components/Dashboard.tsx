"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, dataApi, isBusy, type AppState, type Detail, type Health, type TaskCardT } from "@/lib/client";
import { DataDrawer } from "./DataDrawer";
import { Footer } from "./Footer";
import { TaskDrawer } from "./Drawer";
import { ModelsDrawer } from "./ModelsDrawer";
import { QuickAdd, SAMPLE_TASKS } from "./QuickAdd";
import { Topbar } from "./Topbar";
import { AgentView } from "./views/AgentView";
import { ApprovalsView } from "./views/ApprovalsView";
import { BoardView } from "./views/BoardView";
import { TodayView } from "./views/TodayView";

export const STORAGE_KEY = "todo_agent_storage";
export const COOKIE_NAME = "todo_storage_sync";

function setSyncCookie() {
  if (typeof document !== "undefined") {
    document.cookie = `${COOKIE_NAME}=${Date.now()}; path=/; max-age=31536000; SameSite=Lax`;
  }
}

function headline(tasks: TaskCardT[]): { title: string; detail: string } {
  const open = tasks.filter((t) => t.status !== "done");
  const attention = open.filter((t) => t.status === "needs_you" || t.status === "failed").length;
  const working = open.filter((t) => isBusy(t.status)).length;
  const ready = open.filter((t) => t.status === "ready").length;
  const drafts = tasks.reduce((n, t) => n + t.pending_drafts, 0);
  const parts = [
    ready && `${ready} finished for you`,
    drafts && `${drafts} ${drafts === 1 ? "draft" : "drafts"} to approve`,
    working && `${working} in progress`,
  ].filter(Boolean) as string[];

  if (!tasks.length) return { title: "Hand over anything on your mind.", detail: "The agent sorts it, does what it can, and tells you what is left for you." };
  if (attention) return { title: `${attention} ${attention === 1 ? "thing needs" : "things need"} you.`, detail: parts.join(", ") };
  if (working) return { title: "The agent is on it.", detail: parts.join(", ") };
  return { title: "You are all caught up.", detail: parts.join(", ") || "Nothing is waiting on you." };
}

export function Dashboard() {
  const [state, setState] = useState<AppState | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [panel, setPanel] = useState<"models" | "data" | null>(null);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [today, setToday] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const say = useCallback((text: string, error = false) => {
    setToast({ text, error });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const hydratedRef = useRef(false);
  const lastSavedRef = useRef<string>("");
  const healthRef = useRef<Health | null>(null);

  const persistToStorage = useCallback(async () => {
    if (typeof window === "undefined") return;
    try {
      const exportData = await dataApi.export();
      const json = JSON.stringify(exportData);
      if (json !== lastSavedRef.current) {
        lastSavedRef.current = json;
        localStorage.setItem(STORAGE_KEY, json);
        setSyncCookie();
      }
    } catch {
      /* ignore sync errors during polling */
    }
  }, []);

  const syncToServer = useCallback(async () => {
    if (hydratedRef.current || typeof window === "undefined") return;
    hydratedRef.current = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && ((data.tasks && data.tasks.length > 0) || (data.llm_keys && data.llm_keys.length > 0) || (data.settings && data.settings.length > 0))) {
        const res = await fetch("/api/state", { cache: "no-store" });
        if (res.ok) {
          const current = (await res.json()) as AppState;
          if (current.tasks.length === 0) {
            await dataApi.import(data);
            setSyncCookie();
          }
        }
      }
    } catch (err) {
      console.error("Hydration from localStorage failed", err);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (res.ok) {
        const appState = (await res.json()) as AppState;
        setState(appState);
        if (hydratedRef.current && (appState.tasks.length > 0 || (healthRef.current && healthRef.current.total > 0))) {
          void persistToStorage();
        }
      }
    } catch {
      /* the next poll tries again */
    }
  }, [persistToStorage]);

  const loadDetail = useCallback(async (id: number) => {
    const res = await fetch(`/api/tasks/${id}`, { cache: "no-store" });
    if (res.ok) setDetail((await res.json()) as Detail);
    else setSelectedId(null);
  }, []);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) {
        const h = (await res.json()) as Health;
        healthRef.current = h;
        setHealth(h);
      }
    } catch {
      /* the next check tries again */
    }
  }, []);

  // One-time initialization on mount
  useEffect(() => {
    async function init() {
      await syncToServer();
      await load();
      await checkHealth();
    }
    void init();
    setToday(new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }));
  }, [syncToServer, load, checkHealth]);

  // Periodic polling for tasks (1.2s if busy, 4s if idle)
  const active = !!state?.tasks.some((t) => isBusy(t.status));
  useEffect(() => {
    const timer = setInterval(() => void load(), active ? 1200 : 4000);
    return () => clearInterval(timer);
  }, [load, active]);

  // Periodic health check (every 15s)
  useEffect(() => {
    const timer = setInterval(() => void checkHealth(), 15000);
    return () => clearInterval(timer);
  }, [checkHealth]);

  // Keep the open task in step with the board.
  const card = state?.tasks.find((t) => t.id === selectedId);
  const version = card ? `${card.updated_at}|${card.steps_done}|${card.pending_drafts}` : "";
  useEffect(() => {
    if (selectedId === null) setDetail(null);
    else void loadDetail(selectedId);
  }, [selectedId, version, loadDetail]);

  const refresh = useCallback(() => {
    void load();
    if (selectedId !== null) void loadDetail(selectedId);
  }, [load, loadDetail, selectedId]);

  const act = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        say(err instanceof Error ? err.message : "Something went wrong", true);
      }
      refresh();
    },
    [say, refresh],
  );

  const onToggle = useCallback((t: TaskCardT) => void act(() => api.taskAction(t.id, { action: t.status === "done" ? "reopen" : "done" })), [act]);
  const onRetry = useCallback((id: number) => void act(() => api.taskAction(id, { action: "rerun" })), [act]);
  const onSelect = useCallback((id: number) => setSelectedId(id), []);
  const closeDetail = useCallback(() => setSelectedId(null), []);
  const closePanel = useCallback(() => setPanel(null), []);
  const startWork = useCallback(() => void act(async () => void (await api.start())), [act]);
  const addSamples = useCallback(() => void act(() => api.addTasks(SAMPLE_TASKS)), [act]);

  // Keyboard: n add, / search, j/k move through the list.
  const order = useMemo(() => {
    const open = (state?.tasks ?? []).filter((t) => t.status !== "done");
    const rank = (t: TaskCardT) => (t.status === "failed" ? 0 : t.status === "needs_you" ? 1 : t.status === "ready" ? 2 : 3);
    return open.slice().sort((a, b) => rank(a) - rank(b) || a.priority - b.priority || a.id - b.id).map((t) => t.id);
  }, [state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) {
        if (e.key === "Escape" && el.tagName !== "SELECT") (el as HTMLElement).blur();
        return;
      }
      if (panel) return;
      if (e.key === "n") {
        e.preventDefault();
        document.getElementById("quick-add")?.focus();
      } else if (e.key === "/") {
        e.preventDefault();
        document.getElementById("board-search")?.focus();
      } else if ((e.key === "j" || e.key === "k") && order.length) {
        e.preventDefault();
        const i = selectedId === null ? -1 : order.indexOf(selectedId);
        setSelectedId(order[Math.max(0, Math.min(order.length - 1, i + (e.key === "j" ? 1 : -1)))]);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, order, selectedId]);

  const tasks = state?.tasks ?? [];
  const head = headline(tasks);
  const detailNode = detail && selectedId !== null ? detail : null;

  return (
    <div className="app">
      <div className="main">
        <Topbar working={active} health={health} onModels={() => setPanel("models")} onData={() => setPanel("data")} />

        <header className="pagehead">
          <div className="pagehead-title">
            <p className="pagehead-date">{today || " "}</p>
            <h1>{head.title}</h1>
            <p className="pagehead-detail">{head.detail}</p>
          </div>
          <QuickAdd onAdded={() => void load()} say={say} />
        </header>

        {health?.mode === "mock" && (
          <p className="banner banner-demo" role="status">
            Demo mode: no model is connected, so results are placeholders, not real work. Set <code>LLM_MODE=live</code> in <code>.env.local</code> to use your own models.
          </p>
        )}
        {health?.mode === "live" && health.usable === 0 && (
          <p className="banner banner-bad" role="alert">
            {health.total === 0
              ? "No model is set up yet, so the agent cannot work."
              : health.cooling > 0 && health.nextAvailable
                ? `Every model is cooling down. The first is back at ${new Date(health.nextAvailable).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}.`
                : "No model can be used right now. Check your keys."}{" "}
            <button className="link" onClick={() => setPanel("models")}>
              Open model configuration
            </button>
          </p>
        )}

        {!state ? (
          <p className="empty">Loading</p>
        ) : (
          <div className="dash">
            <div className="dash-main">
              <TodayView
                state={state}
                health={health}
                selectedId={selectedId}
                onSelect={onSelect}
                onToggle={onToggle}
                onRetry={onRetry}
                onModels={() => setPanel("models")}
                onSample={addSamples}
                onStart={startWork}
                onSuggest={(text) => void act(() => api.addTasks(text))}
              />
              {tasks.length > 0 && (
                <section className="dash-section" aria-labelledby="board-h">
                  <h2 id="board-h" className="dash-title">
                    Everything, by who does the work
                  </h2>
                  <BoardView tasks={tasks} selectedId={selectedId} onSelect={onSelect} onToggle={onToggle} onRetry={onRetry} />
                </section>
              )}
            </div>

            <aside className="dash-side" aria-label="Approvals and agent">
              <section className="dash-section" aria-labelledby="appr-h">
                <h2 id="appr-h" className="dash-title">
                  Approvals <span className="count">{state.approvals.length}</span>
                </h2>
                <ApprovalsView state={state} onOpen={onSelect} onDecide={(id, d) => void act(() => api.decide(id, d))} say={say} />
              </section>
              <section className="dash-section" aria-labelledby="agent-h">
                <h2 id="agent-h" className="dash-title">
                  Agent
                </h2>
                <AgentView state={state} onOpen={onSelect} />
              </section>
            </aside>
          </div>
        )}

        <Footer />
      </div>

      {detailNode && selectedId !== null && !panel && <TaskDrawer detail={detailNode} onClose={closeDetail} onChanged={refresh} say={say} />}
      {panel === "models" && (
        <ModelsDrawer
          mode={health?.mode ?? "live"}
          onClose={closePanel}
          onChanged={() => {
            void checkHealth();
            void persistToStorage();
          }}
          say={say}
        />
      )}
      {panel === "data" && (
        <DataDrawer
          onClose={closePanel}
          onChanged={() => {
            setSelectedId(null);
            void load();
            void checkHealth();
          }}
          say={say}
        />
      )}

      <div className="toast-wrap" aria-live="polite">
        {toast && <div className={`toast ${toast.error ? "toast-error" : ""}`}>{toast.text}</div>}
      </div>
    </div>
  );
}
