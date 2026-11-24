import { z } from "zod";
import { getDeps } from "@/lib/runtime";
import { deleteKey, patchKey } from "@/lib/router/admin";
import { paramId, readJson, respond } from "@/lib/router/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const Patch = z.object({ label: z.string().min(1).max(60).optional(), status: z.enum(["active", "disabled"]).optional() });

export const PATCH = (req: Request, ctx: Ctx) =>
  respond(async () => {
    patchKey(getDeps().db, await paramId(ctx), await readJson(req, Patch.parse));
    return { ok: true };
  });

export const DELETE = (_req: Request, ctx: Ctx) =>
  respond(async () => {
    deleteKey(getDeps().db, await paramId(ctx));
  });
