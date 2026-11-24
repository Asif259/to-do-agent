import type { PendingDraft, TaskCard, getDetail, getState } from "./store";
import type { ExportData } from "./data";
import type { RouterState } from "./router/types";
import type { Channel, Pile, Status } from "./types";

export type { RouterState, ExportData };

export type TaskCardT = TaskCard;
export type DraftT = PendingDraft;
export type AppState = ReturnType<typeof getState> & {
  config: { mode: "live" | "mock"; workerConcurrency: number };
};
export type Detail = NonNullable<ReturnType<typeof getDetail>>;
export interface Health {
  mode: "live" | "mock";
  usable: number;
  cooling: number;
  total: number;
  nextAvailable: string | null;
}

async function send<T = void>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  addTasks: (text: string) => send("POST", "/api/tasks", { text }),
  start: () => send<{ queued: number }>("POST", "/api/start"),
  taskAction: (id: number, body: { action: "done" | "reopen" | "rerun" } | { action: "move"; pile: Pile }) =>
    send("PATCH", `/api/tasks/${id}`, body),
  deleteTask: (id: number) => send("DELETE", `/api/tasks/${id}`),
  step: (id: number, done: boolean) => send("PATCH", `/api/steps/${id}`, { done }),
  decide: (id: number, decision: "approved" | "rejected") => send("POST", `/api/outbox/${id}`, { decision }),
};

export interface AddKeyBody {
  preset: string;
  label: string;
  api_key: string;
  base_url?: string;
  name?: string;
}

export interface TestResult {
  text: string;
  provider: string;
  model: string;
  attempts: number;
}

export interface DataInfo {
  path: string;
  bytes: number;
  tasks: number;
  drafts: number;
  keys: number;
  models: number;
}

export const dataApi = {
  info: async (): Promise<DataInfo> => {
    const res = await fetch("/api/data", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not read storage details");
    return (await res.json()) as DataInfo;
  },
  clear: (clear: "tasks" | "keys" | "all") => send<DataInfo>("POST", "/api/data", { clear }),
  export: async (): Promise<ExportData> => {
    const res = await fetch("/api/data/sync", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not export storage data");
    return (await res.json()) as ExportData;
  },
  import: (data: Partial<ExportData>) => send<{ ok: boolean }>("POST", "/api/data/sync", data),
};

export const llmApi = {
  state: async (): Promise<RouterState> => {
    const res = await fetch("/api/llm/state", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not load model configuration");
    return (await res.json()) as RouterState;
  },
  addKey: (body: AddKeyBody) => send<{ id: number }>("POST", "/api/llm/keys", body),
  setKeyStatus: (id: number, status: "active" | "disabled") => send("PATCH", `/api/llm/keys/${id}`, { status }),
  deleteKey: (id: number) => send("DELETE", `/api/llm/keys/${id}`),
  syncKey: (id: number) => send<{ added: number; kept: number; removed: number; total: number }>("POST", `/api/llm/keys/${id}/sync`),
  freeOnly: (providerId: number, free_only: boolean) => send("PATCH", `/api/llm/providers/${providerId}`, { free_only }),
  patchModel: (id: number, patch: { enabled?: boolean; priority?: number }) => send("PATCH", `/api/llm/models/${id}`, patch),
  resetCooldowns: () => send<{ reset: number }>("POST", "/api/llm/actions", { action: "reset_cooldowns" }),
  setStrategy: (strategy: string) => send("POST", "/api/llm/actions", { action: "set_strategy", strategy }),
  test: (prompt: string) => send<TestResult>("POST", "/api/llm/actions", { action: "test", prompt }),
};

export const PILE_META: Record<Pile, { title: string; short: string; caption: string; empty: string }> = {
  agent: {
    title: "Handled for you",
    short: "Agent",
    caption: "The agent finishes these on its own.",
    empty: "Research, planning and writing the agent can finish alone will land here.",
  },
  together: {
    title: "Done together",
    short: "Together",
    caption: "The agent prepares. You finish.",
    empty: "Anything the agent can prepare but only you can send, book or decide.",
  },
  mine: {
    title: "Only you",
    short: "You",
    caption: "Yours to do, with a reminder or script ready.",
    empty: "Calls, appointments and anything that needs you in person.",
  },
};

export const CATEGORIES_ORDER = ["work", "home", "family", "money", "health", "other"] as const;

export const CATEGORY_LABEL: Record<string, string> = {
  work: "Work",
  home: "Home",
  family: "Family",
  money: "Money",
  health: "Health",
  other: "Other",
};

export const CHANNEL_LABEL: Record<Channel, string> = {
  email: "Email",
  message: "Message",
  calendar: "Calendar invite",
  post: "Post",
  other: "Note",
};

export const isBusy = (s: Status) => ["triaging", "working", "reviewing"].includes(s);

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function agentLabel(agent: string): string {
  if (agent.startsWith("worker-")) return `Worker ${agent.slice(7)}`;
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

/** Ideas to add next, keyed by category. Shown for categories already in the list. */
export const SUGGESTIONS: Record<string, string[]> = {
  work: ["Summarise this week's progress for my manager", "Draft an agenda for my next team meeting"],
  home: ["Make a monthly home maintenance checklist", "Plan a decluttering schedule room by room"],
  family: ["Plan a family game night", "Draft a message asking everyone for gift ideas"],
  money: ["List subscriptions I can cancel", "Build a simple monthly budget template"],
  health: ["Draft a weekly workout and meal plan", "Prepare questions for my next check-up"],
  other: ["Make a one-page planner for next month"],
};

export function suggestionsFor(tasks: { category: string | null; title: string }[], max = 4): string[] {
  const have = new Set(tasks.map((t) => t.title.toLowerCase()));
  const cats = [...new Set(tasks.map((t) => t.category).filter((c): c is string => !!c))];
  return cats
    .flatMap((c) => SUGGESTIONS[c] ?? [])
    .filter((s) => !have.has(s.toLowerCase()))
    .slice(0, max);
}
