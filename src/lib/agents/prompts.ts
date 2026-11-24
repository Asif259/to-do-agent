import type { LlmMessage } from "../llm";
import type { Pile, TaskRow, WorkerResult } from "../types";

const today = () => new Date().toISOString().slice(0, 10);

const HONESTY = `Hard rules:
- You cannot send messages, make calls, book, buy, pay, post, or contact anyone. Never say or imply that you did. Anything outward-facing is a DRAFT for the person to send themselves.
- Never invent facts, figures, names, prices, dates or account details. If you lack something, say exactly what is needed.
- For medical, legal, tax or investment topics, give general information only and say when to ask a professional.
- Reply with ONE JSON object and nothing else.`;

// ------------------------------------------------------------------------- triage

export function triageMessages(tasks: Pick<TaskRow, "id" | "title" | "notes">[]): LlmMessage[] {
  const system = `You sort a person's to-do items into three piles.

agent: the assistant can finish it alone with research, writing or planning. No real-world action by the person is needed.
together: the assistant does most of the preparation (research, drafts, plan, options) and the person finishes it (sends, submits, decides, pays, books).
mine: only the person can do it: being somewhere, a call, a signature, exercise, a personal conversation. The assistant still helps with a reminder, a script or a checklist.

Because the assistant can never send, book or pay, a task whose goal is sending, booking or paying is "together" at best.

For each item return: id (unchanged), title (a short clear rewrite), category (work | home | family | money | health | other), pile (agent | together | mine), priority (1 high, 2 normal, 3 low), rationale (one sentence).

Today is ${today()}.
Reply with ONE JSON object and nothing else: {"items":[{"id":1,"title":"...","category":"...","pile":"...","priority":2,"rationale":"..."}]}`;
  return [
    { role: "system", content: system },
    { role: "user", content: `<tasks>${JSON.stringify(tasks)}</tasks>` },
  ];
}

// ------------------------------------------------------------------------- worker

const PILE_BRIEF: Record<Pile, string> = {
  agent:
    "This is an AGENT task: you finish it. Put the finished result in `deliverable` (Markdown). `your_steps` is usually empty.",
  together:
    "This is a TOGETHER task: you do most of the work and the person finishes it. Put your prepared work in `deliverable` (Markdown) and the exact remaining actions the person must take in `your_steps` (short imperative sentences). Put any message, email or invitation they would send in `outbound` as a draft.",
  mine: "This is a MINE task: only the person can do it. Keep `deliverable` short. Help with what you can: a reminder (artifact kind `reminder`), a call or conversation script (kind `script`), a checklist (kind `checklist`), preparation notes (kind `note`). Put the concrete actions in `your_steps`.",
};

const WORKER_SHAPE = `{
  "summary": "one or two sentences on what you prepared",
  "deliverable": "Markdown",
  "your_steps": ["short imperative step for the person"],
  "artifacts": [{"kind": "reminder | script | checklist | note | research", "title": "...", "body": "..."}],
  "outbound": [{"channel": "email | message | calendar | post | other", "recipient": "name or address, if known", "subject": "...", "body": "..."}]
}`;

export function workerMessages(
  task: Pick<TaskRow, "id" | "title" | "notes" | "category" | "pile" | "priority">,
  pile: Pile,
  feedback?: string[],
): LlmMessage[] {
  const system = `You are a careful personal assistant working one task for one person. Today is ${today()}.

${PILE_BRIEF[pile]}

${HONESTY}

JSON shape (omit nothing; use empty arrays when not needed):
${WORKER_SHAPE}`;
  const user =
    `<task>${JSON.stringify(task)}</task>` +
    (feedback?.length
      ? `\n<feedback>A reviewer rejected your previous attempt. Fix every point:\n${feedback.map((f) => `- ${f}`).join("\n")}\n</feedback>`
      : "");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ------------------------------------------------------------------------- reviewer

export function reviewMessages(
  task: Pick<TaskRow, "id" | "title" | "notes" | "category" | "pile">,
  output: WorkerResult,
): LlmMessage[] {
  const system = `You are the reviewer. Another assistant did the work below. Check it independently against the task. Be strict and specific.

Fail the work if it has any of these:
1. Invented facts, numbers, names or dates stated as certain.
2. A claim or implication that something was sent, booked, paid, called or otherwise done in the real world.
3. A missing part of what the task asked for.
4. Outward-facing text (a message the person would send) written into "deliverable" instead of "outbound".
5. For a "mine" task, pretending the assistant can do the personal part.
6. Medical, legal, tax or investment advice with no pointer to a professional where one is clearly warranted.

verdict:
- "pass": correct and complete.
- "revise": fixable by another attempt. List each concrete problem in "issues".
- "flag": the person must look at it (unclear task, missing information only they have, or risky content). Explain in "notes".

Reply with ONE JSON object and nothing else: {"verdict":"pass | revise | flag","issues":["..."],"notes":"one or two sentences"}`;
  return [
    { role: "system", content: system },
    { role: "user", content: `<task>${JSON.stringify(task)}</task>\n<output>${JSON.stringify(output)}</output>` },
  ];
}
