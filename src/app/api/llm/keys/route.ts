import { z } from "zod";
import { getDeps } from "@/lib/runtime";
import { addKey } from "@/lib/router/admin";
import { readJson, respond } from "@/lib/router/http";

export const dynamic = "force-dynamic";

const Body = z.object({
  preset: z.string().min(1),
  label: z.string().min(1).max(60),
  api_key: z.string().min(1).max(500),
  base_url: z.string().max(300).optional(),
  name: z.string().max(60).optional(),
});

export const POST = (req: Request) => respond(async () => addKey(getDeps().db, await readJson(req, Body.parse)), 201);
