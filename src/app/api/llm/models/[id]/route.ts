import { z } from "zod";
import { getDeps } from "@/lib/runtime";
import { patchModel } from "@/lib/router/admin";
import { paramId, readJson, respond } from "@/lib/router/http";

export const dynamic = "force-dynamic";

const Patch = z.object({ enabled: z.boolean().optional(), priority: z.number().int().min(0).max(9999).optional() });

export const PATCH = (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  respond(async () => {
    patchModel(getDeps().db, await paramId(ctx), await readJson(req, Patch.parse));
    return { ok: true };
  });
