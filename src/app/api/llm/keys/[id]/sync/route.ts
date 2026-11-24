import { getDeps } from "@/lib/runtime";
import { syncKey } from "@/lib/router/admin";
import { paramId, respond } from "@/lib/router/http";

export const dynamic = "force-dynamic";

export const POST = (_req: Request, ctx: { params: Promise<{ id: string }> }) =>
  respond(async () => syncKey(getDeps().db, await paramId(ctx)));
