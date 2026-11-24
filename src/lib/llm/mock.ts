import type { Llm, LlmRequest } from "./index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

const MINE = /\b(call|phone|dentist|doctor|appointment|gym|workout|sign|visit|pick up|attend|walk|therapy|haircut|vaccin|run)\b/i;
const ACT = /\b(email|e-mail|send|reply|book|pay|renew|submit|order|buy|cancel|ask|tell|message)\b/i;
const THINK = /\b(research|compare|find|summari[sz]e|outline|plan|draft|write|look up|review|organi[sz]e|budget|schedule|prepare)\b/i;

function category(title: string): string {
  if (/\b(doctor|dentist|gym|workout|vaccin|therapy|sleep|diet|run|health)\b/i.test(title)) return "health";
  if (/\b(tax|taxes|pay|invoice|budget|bank|insurance|bill|invest|rent|mortgage|savings)\b|\$/i.test(title)) return "money";
  if (/\b(mom|dad|kid|kids|school|birthday|family|wife|husband|partner|son|daughter|parent|parents)\b/i.test(title)) return "family";
  if (/\b(home|house|landlord|plumb\w*|clean\w*|garden|repair|grocer\w*|laundry|car)\b/i.test(title)) return "home";
  if (/\b(client|report|slides|meeting|project|boss|deck|team|presentation|work)\b/i.test(title)) return "work";
  return "other";
}

function pile(title: string): "agent" | "together" | "mine" {
  if (MINE.test(title)) return "mine";
  if (ACT.test(title)) return "together";
  if (THINK.test(title)) return "agent";
  return "together";
}

const DEMO = "Demo mode: no model is connected, so this is a placeholder, not real work.";

function tagged<T>(content: string, tag: string): T {
  const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) throw new Error(`mock: missing <${tag}>`);
  return JSON.parse(m[1]) as T;
}

/** Deterministic stand-in so the dashboard can be shown without any model. Clearly labelled as demo. */
export class MockLlm implements Llm {
  async complete({ role, messages }: LlmRequest): Promise<string> {
    const user = messages[messages.length - 1].content;

    if (role === "triage") {
      await sleep(jitter(400, 800));
      const tasks = tagged<{ id: number; title: string }[]>(user, "tasks");
      return JSON.stringify({
        items: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          category: category(t.title),
          pile: pile(t.title),
          priority: /\b(urgent|asap|today|tomorrow|deadline)\b/i.test(t.title) ? 1 : 2,
          rationale: `Demo triage from keywords in "${t.title}".`,
        })),
      });
    }

    if (role === "reviewer") {
      await sleep(jitter(400, 800));
      return JSON.stringify({ verdict: "pass", issues: [], notes: "Demo review: structure looks complete." });
    }

    await sleep(jitter(1200, 2600));
    const task = tagged<{ title: string; pile: "agent" | "together" | "mine" }>(user, "task");
    const base = {
      summary: `[Demo] Placeholder prepared for "${task.title}".`,
      deliverable: `## ${task.title}\n\n> ${DEMO}\n\n1. Clarify the goal and the deadline.\n2. Gather what you already have.\n3. Do the first small piece today.`,
      your_steps: [] as string[],
      artifacts: [] as { kind: string; title: string; body: string }[],
      outbound: [] as { channel: string; recipient: string; subject: string; body: string }[],
    };
    if (task.pile === "together") {
      base.your_steps = ["Read the prepared draft", "Adjust anything that is not right", "Send or submit it yourself"];
      if (ACT.test(task.title)) {
        base.outbound.push({
          channel: "email",
          recipient: "",
          subject: task.title,
          body: `Hello,\n\n(${DEMO})\n\nRegarding: ${task.title}.\n\nThank you.`,
        });
      }
    }
    if (task.pile === "mine") {
      base.your_steps = ["Set aside the time", "Do it", "Tick it off here"];
      base.artifacts.push(
        { kind: "reminder", title: "Reminder text", body: `Reminder: ${task.title}. (${DEMO})` },
        { kind: "checklist", title: "Before you start", body: "- [ ] Have what you need ready\n- [ ] Block 30 minutes" },
      );
    }
    return JSON.stringify(base);
  }
}
