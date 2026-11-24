import { z } from "zod";
import { getDeps } from "@/lib/runtime";
import { resetCooldowns, setStrategy } from "@/lib/router/admin";
import { routedComplete } from "@/lib/router/call";
import { readJson, respond } from "@/lib/router/http";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reset_cooldowns") }),
  z.object({ action: z.literal("set_strategy"), strategy: z.string() }),
  z.object({ action: z.literal("test"), prompt: z.string().min(1).max(2000) }),
]);

export const POST = (req: Request) =>
  respond(async () => {
    const { db } = getDeps();
    const body = await readJson(req, Body.parse);
    if (body.action === "reset_cooldowns") return { reset: resetCooldowns(db) };
    if (body.action === "set_strategy") return { strategy: setStrategy(db, body.strategy) };
    return routedComplete(db, { role: "test", messages: [{ role: "user", content: body.prompt }], temperature: 0.5 });
  });
