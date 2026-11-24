import { NextResponse } from "next/server";
import { RouterError } from "./types";

/** Run a handler and turn RouterError into a JSON error with the right status. */
export async function respond(fn: () => unknown | Promise<unknown>, success = 200): Promise<NextResponse> {
  try {
    const body = await fn();
    return body === undefined ? new NextResponse(null, { status: 204 }) : NextResponse.json(body, { status: success });
  } catch (err) {
    if (err instanceof RouterError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error" }, { status: 500 });
  }
}

export async function paramId(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id < 1) throw new RouterError("Not found", 404);
  return id;
}

export async function readJson<T>(req: Request, parse: (v: unknown) => T): Promise<T> {
  const raw = await req.json().catch(() => undefined);
  try {
    return parse(raw);
  } catch {
    throw new RouterError("That request was not valid.", 400);
  }
}
