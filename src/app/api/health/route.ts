import { NextResponse } from "next/server";
import { getDeps } from "@/lib/runtime";
import { poolHealth } from "@/lib/router/engine";

export const dynamic = "force-dynamic";

/** Can the agent call a model right now? Cheap: reads the pool, makes no network call. */
export function GET() {
  const { db, config } = getDeps();
  if (config.mode === "mock") return NextResponse.json({ mode: "mock", usable: 0, cooling: 0, total: 0, nextAvailable: null });
  return NextResponse.json({ mode: "live", ...poolHealth(db) });
}
