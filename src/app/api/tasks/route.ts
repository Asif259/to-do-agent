import { NextResponse } from "next/server";
import { z } from "zod";
import { parseLines } from "@/lib/parse";
import { getDeps } from "@/lib/runtime";
import { addTasks } from "@/lib/store";

export const dynamic = "force-dynamic";

const Body = z.object({ text: z.string().min(1).max(20_000) });

/** Add tasks (one per line) to the queue. Work starts when the person clicks "Get it done". */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Send { text } with one task per line." }, { status: 400 });

  const titles = parseLines(parsed.data.text);
  if (!titles.length) return NextResponse.json({ error: "No tasks found in that text." }, { status: 400 });

  const ids = addTasks(getDeps().db, titles.map((title) => ({ title })));
  return NextResponse.json({ ids }, { status: 201 });
}
