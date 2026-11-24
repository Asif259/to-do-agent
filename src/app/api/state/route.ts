import { NextResponse } from "next/server";
import { getDeps } from "@/lib/runtime";
import { getState } from "@/lib/store";

export const dynamic = "force-dynamic";

export function GET() {
  const { db, config } = getDeps();
  return NextResponse.json({
    ...getState(db),
    config: { mode: config.mode, workerConcurrency: config.workerConcurrency },
  });
}
