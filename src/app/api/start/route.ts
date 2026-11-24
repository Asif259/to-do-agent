import { NextResponse } from "next/server";
import { getDeps, kick } from "@/lib/runtime";
import { countQueued } from "@/lib/store";

export const dynamic = "force-dynamic";

/** "Get it done": hand every queued task to the agents. Returns at once; work runs in the background. */
export async function POST() {
  const queued = countQueued(getDeps().db);
  if (queued) kick();
  return NextResponse.json({ queued });
}
