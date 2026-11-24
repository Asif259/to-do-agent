import { NextResponse } from "next/server";
import { z } from "zod";
import { getDeps } from "@/lib/runtime";
import { setStepDone } from "@/lib/store";

export const dynamic = "force-dynamic";

const Body = z.object({ done: z.boolean() });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!Number.isInteger(id) || !body.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  return setStepDone(getDeps().db, id, body.data.done)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "Not found" }, { status: 404 });
}
