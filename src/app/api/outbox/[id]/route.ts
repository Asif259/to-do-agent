import { NextResponse } from "next/server";
import { z } from "zod";
import { getDeps } from "@/lib/runtime";
import { decideOutbox } from "@/lib/store";

export const dynamic = "force-dynamic";

const Body = z.object({ decision: z.enum(["approved", "rejected"]) });

/**
 * Record the person's decision on a draft. This does not send anything: approving
 * only marks the draft as cleared so the person can copy it and send it themselves.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!Number.isInteger(id) || !body.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  return decideOutbox(getDeps().db, id, body.data.decision)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "Draft not found or already decided." }, { status: 409 });
}
