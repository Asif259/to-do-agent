import { z } from "zod";
import { getDeps } from "@/lib/runtime";
import { patchProvider } from "@/lib/router/admin";
import { paramId, readJson, respond } from "@/lib/router/http";

export const dynamic = "force-dynamic";

const Patch = z.object({ free_only: z.boolean().optional() });

export const PATCH = (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  respond(async () => {
    patchProvider(getDeps().db, await paramId(ctx), await readJson(req, Patch.parse));
    return { ok: true };
  });
