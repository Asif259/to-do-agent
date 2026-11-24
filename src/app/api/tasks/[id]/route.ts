import { NextResponse } from "next/server";
import { z } from "zod";
import { getDeps, kick } from "@/lib/runtime";
import { deleteTask, getDetail, getTask, logEvent, requeue, updateTask } from "@/lib/store";
import { PILES } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const BUSY = ["triaging", "working", "reviewing"];

async function taskId(ctx: Ctx): Promise<number | null> {
  const id = Number((await ctx.params).id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_req: Request, ctx: Ctx) {
  const id = await taskId(ctx);
  const detail = id ? getDetail(getDeps().db, id) : undefined;
  return detail ? NextResponse.json(detail) : NextResponse.json({ error: "Not found" }, { status: 404 });
}

const Patch = z.discriminatedUnion("action", [
  z.object({ action: z.literal("done") }),
  z.object({ action: z.literal("reopen") }),
  z.object({ action: z.literal("rerun") }),
  z.object({ action: z.literal("move"), pile: z.enum(PILES) }),
]);

export async function PATCH(req: Request, ctx: Ctx) {
  const { db } = getDeps();
  const id = await taskId(ctx);
  const task = id ? getTask(db, id) : undefined;
  if (!id || !task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = Patch.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (BUSY.includes(task.status)) {
    return NextResponse.json({ error: "The agent is still working on this task." }, { status: 409 });
  }

  switch (body.data.action) {
    case "done":
      updateTask(db, id, { status: "done" });
      break;
    case "reopen":
      updateTask(db, id, { status: task.pile === "agent" && task.verdict === "pass" ? "ready" : "needs_you" });
      break;
    case "move":
      updateTask(db, id, { pile: body.data.pile });
      logEvent(db, { task_id: id, agent: "you", kind: "info", message: `Moved to ${body.data.pile}` });
      break;
    case "rerun":
      requeue(db, id);
      kick();
      break;
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const id = await taskId(ctx);
  if (!id) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return deleteTask(getDeps().db, id)
    ? new NextResponse(null, { status: 204 })
    : NextResponse.json({ error: "Task not found or still being worked." }, { status: 409 });
}
