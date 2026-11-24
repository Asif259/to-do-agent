import { z } from "zod";

export const CATEGORIES = ["work", "home", "family", "money", "health", "other"] as const;
export const PILES = ["agent", "together", "mine"] as const;
export const STATUSES = [
  "inbox",
  "triaging",
  "working",
  "reviewing",
  "ready",
  "needs_you",
  "done",
  "failed",
] as const;
export const ARTIFACT_KINDS = ["reminder", "script", "checklist", "note", "research"] as const;
export const CHANNELS = ["email", "message", "calendar", "post", "other"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Pile = (typeof PILES)[number];
export type Status = (typeof STATUSES)[number];
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type Channel = (typeof CHANNELS)[number];
export type AgentRole = "triage" | "worker" | "reviewer";

// ---------------------------------------------------------------- lenient model output schemas
// Free-tier models drift on casing and wording, so enums are normalised before validation.

function lenientEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  fallback?: T[number],
  aliases: Record<string, T[number]> = {},
) {
  const pre = (v: unknown) => {
    if (typeof v !== "string") return v;
    const s = v.toLowerCase().trim();
    return aliases[s] ?? s;
  };
  const base = z.enum(values);
  return z.preprocess(pre, fallback ? base.catch(fallback) : base) as unknown as z.ZodType<T[number]>;
}

const text = z.preprocess(
  (v) => (v && typeof v === "object" && "text" in v ? (v as { text: unknown }).text : v),
  z.string(),
);

export const TriageResultSchema = z.object({
  items: z.array(
    z.object({
      id: z.coerce.number().int(),
      title: z.string().trim().min(1).max(200),
      category: lenientEnum(CATEGORIES, "other", { finance: "money", financial: "money", job: "work", household: "home", kids: "family" }),
      pile: lenientEnum(PILES, undefined, {
        ai: "agent",
        assistant: "agent",
        alone: "agent",
        collab: "together",
        shared: "together",
        both: "together",
        me: "mine",
        user: "mine",
        you: "mine",
        only_me: "mine",
        "only me": "mine",
      }),
      priority: z.coerce.number().int().min(1).max(3).catch(2),
      rationale: z.string().max(600).catch(""),
    }),
  ),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

export const WorkerResultSchema = z.object({
  summary: z.string().catch(""),
  deliverable: z.string().catch(""),
  your_steps: z.array(text).catch([]),
  artifacts: z
    .array(
      z.object({
        kind: lenientEnum(ARTIFACT_KINDS, "note"),
        title: z.string().catch("Untitled"),
        body: z.string(),
      }),
    )
    .catch([]),
  outbound: z
    .array(
      z.object({
        channel: lenientEnum(CHANNELS, "other", { mail: "email", "e-mail": "email", sms: "message", text: "message", chat: "message" }),
        recipient: z.string().catch(""),
        subject: z.string().catch(""),
        body: z.string(),
      }),
    )
    .catch([]),
});
export type WorkerResult = z.infer<typeof WorkerResultSchema>;

export const ReviewResultSchema = z.object({
  verdict: lenientEnum(["pass", "revise", "flag"] as const, undefined, { ok: "pass", approved: "pass", approve: "pass", fail: "revise", reject: "revise" }),
  issues: z.array(text).catch([]),
  notes: z.string().catch(""),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

// ---------------------------------------------------------------- rows shared with the UI

export interface TaskRow {
  id: number;
  title: string;
  notes: string | null;
  category: Category;
  pile: Pile | null;
  priority: number;
  rationale: string | null;
  status: Status;
  agent: string | null;
  summary: string | null;
  deliverable: string | null;
  verdict: "pass" | "flag" | null;
  review_notes: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface StepRow {
  id: number;
  task_id: number;
  text: string;
  done: number;
  position: number;
}

export interface ArtifactRow {
  id: number;
  task_id: number;
  kind: ArtifactKind;
  title: string;
  body: string;
}

export interface OutboxRow {
  id: number;
  task_id: number;
  channel: Channel;
  recipient: string;
  subject: string;
  body: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  decided_at: string | null;
}

export interface ReviewRow {
  id: number;
  task_id: number;
  round: number;
  verdict: "pass" | "revise" | "flag";
  issues: string;
  notes: string;
  created_at: string;
}

export interface EventRow {
  id: number;
  ts: string;
  task_id: number | null;
  agent: string;
  kind: "info" | "start" | "done" | "error" | "review";
  message: string;
}
