import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/lib/db";
import { RoutedLlm } from "../src/lib/llm/routed";
import { addKey, deleteKey, getRouterState, patchModel, patchProvider, resetCooldowns, setStrategy, syncKey } from "../src/lib/router/admin";
import { routedComplete } from "../src/lib/router/call";
import { classifyResponse, nextUtcMidnight, parseRetryAfter } from "../src/lib/router/classify";
import { isChatModel } from "../src/lib/router/discovery";
import { poolHealth } from "../src/lib/router/engine";
import { RouterError } from "../src/lib/router/types";

const A = "https://a.test/v1";
const B = "https://b.test/v1";
const NOW = new Date("2026-11-24T10:00:00.000Z");
const MSG = [{ role: "user" as const, content: "hi" }];

type Handler = (init: RequestInit) => Response | Promise<Response>;

/** A fake fetch keyed by URL. Records every call. */
function fakeFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const counters: Record<string, number> = {};
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unmocked ${url}`);
    const n = (counters[url] = (counters[url] ?? 0) + 1) - 1;
    const handler = Array.isArray(route) ? route[Math.min(n, route.length - 1)] : route;
    return handler(init);
  }) as typeof fetch;
  const count = (url: string) => calls.filter((c) => c.url === url).length;
  return { fn, calls, count };
}

const ok = (content = "hello"): Handler => () => Response.json({ choices: [{ message: { content } }] });
const status = (code: number, body = "", headers: Record<string, string> = {}): Handler => () =>
  new Response(body, { status: code, headers });

/** Insert provider, key and model rows. Returns the model id. */
function seed(db: Db, base: string, model: string, o: { key?: string; priority?: number; name?: string } = {}): number {
  let p = db.prepare("SELECT id FROM llm_providers WHERE base_url = ?").get(base) as { id: number } | undefined;
  if (!p) p = { id: Number(db.prepare("INSERT INTO llm_providers (name, preset, base_url) VALUES (?, 'custom', ?)").run(o.name ?? base, base).lastInsertRowid) };
  const keyValue = o.key ?? "sk-test";
  let k = db.prepare("SELECT id FROM llm_keys WHERE provider_id = ? AND key_value = ?").get(p.id, keyValue) as { id: number } | undefined;
  if (!k) k = { id: Number(db.prepare("INSERT INTO llm_keys (provider_id, label, key_value) VALUES (?, ?, ?)").run(p.id, keyValue, keyValue).lastInsertRowid) };
  return Number(db.prepare("INSERT INTO llm_models (key_id, model_id, priority) VALUES (?, ?, ?)").run(k.id, model, o.priority ?? 100).lastInsertRowid);
}

const model = (db: Db, id: number) => db.prepare("SELECT * FROM llm_models WHERE id = ?").get(id) as Record<string, string | number | null>;
const keyOf = (db: Db, modelId: number) =>
  db.prepare("SELECT k.* FROM llm_keys k JOIN llm_models m ON m.key_id = k.id WHERE m.id = ?").get(modelId) as Record<string, string>;
const call = (db: Db, f: ReturnType<typeof fakeFetch>) => routedComplete(db, { role: "worker", messages: MSG, fetch: f.fn, now: () => NOW });
const secondsFromNow = (iso: unknown) => (Date.parse(String(iso)) - NOW.getTime()) / 1000;

describe("failure classification", () => {
  const c = (code: number, ra: string | null = null, body = "") => classifyResponse(code, ra, body, NOW);

  it("429 honours Retry-After, falls back to 60 s, and waits until UTC midnight for a daily quota", () => {
    expect(secondsFromNow(c(429, "120").until)).toBe(120);
    expect(secondsFromNow(c(429).until)).toBe(60);
    expect(c(429, null, "Rate limit reached on tokens per day (TPD)").until).toBe("2026-11-25T00:00:00.000Z");
  });
  it("401 and 402 disable the key; 403 and 404 only the model", () => {
    expect([401, 402].map((s) => c(s).action)).toEqual(["disable_key", "disable_key"]);
    expect([403, 404].map((s) => c(s).action)).toEqual(["disable_model", "disable_model"]);
  });
  it("408 and 5xx cool down 30 s; other 4xx pass through", () => {
    for (const s of [408, 500, 502, 503, 504]) {
      expect(c(s).action).toBe("cooldown");
      expect(secondsFromNow(c(s).until)).toBe(30);
    }
    expect([400, 422, 413].map((s) => c(s).action)).toEqual(["passthrough", "passthrough", "passthrough"]);
  });
  it("parses Retry-After dates and never returns a time in the past", () => {
    expect(parseRetryAfter("Tue, 24 Nov 2026 10:05:00 GMT", NOW)?.toISOString()).toBe("2026-11-24T10:05:00.000Z");
    expect(secondsFromNow(parseRetryAfter("Tue, 24 Nov 2026 09:00:00 GMT", NOW)?.toISOString())).toBe(1);
    expect(parseRetryAfter("soon", NOW)).toBeNull();
    expect(nextUtcMidnight(new Date("2026-12-31T23:59:59Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("routedComplete failover", () => {
  it("returns the reply and sends the key and the entry's own model name", async () => {
    const db = openDb(":memory:");
    seed(db, A, "real-model", { key: "sk-a", name: "Alpha" });
    const f = fakeFetch({ [`${A}/chat/completions`]: ok("hello back") });

    const r = await call(db, f);

    expect(r).toEqual({ text: "hello back", provider: "Alpha", model: "real-model", attempts: 1 });
    const init = f.calls[0].init;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-a");
    expect(JSON.parse(init.body as string).model).toBe("real-model");
  });

  it("429 cools the model down and the next request skips it", async () => {
    const db = openDb(":memory:");
    const a = seed(db, A, "ma", { priority: 1 });
    seed(db, B, "mb", { priority: 2 });
    const f = fakeFetch({ [`${A}/chat/completions`]: status(429, "", { "Retry-After": "120" }), [`${B}/chat/completions`]: ok() });

    const r = await call(db, f);
    expect(r.model).toBe("mb");
    expect(r.attempts).toBe(2);
    expect(model(db, a).status).toBe("cooling_down");
    expect(secondsFromNow(model(db, a).cooldown_until)).toBe(120);

    await call(db, f);
    expect(f.count(`${A}/chat/completions`)).toBe(1);
    expect(f.count(`${B}/chat/completions`)).toBe(2);
  });

  it("401 disables the whole key, so its other models are not tried", async () => {
    const db = openDb(":memory:");
    const first = seed(db, A, "m1", { key: "sk-bad", priority: 1 });
    const second = seed(db, A, "m2", { key: "sk-bad", priority: 2 });
    seed(db, B, "mb", { priority: 3 });
    const f = fakeFetch({ [`${A}/chat/completions`]: status(401, "bad key"), [`${B}/chat/completions`]: ok() });

    const r = await call(db, f);

    expect(r.model).toBe("mb");
    expect(f.count(`${A}/chat/completions`)).toBe(1);
    expect(keyOf(db, first).status).toBe("disabled");
    expect(String(keyOf(db, first).last_error)).toContain("401");
    expect(model(db, second).status).toBe("active");
  });

  it("402 disables the key; 403 disables only that model", async () => {
    const db = openDb(":memory:");
    const a = seed(db, A, "ma", { priority: 1 });
    const b = seed(db, B, "mb", { priority: 2 });
    seed(db, "https://c.test/v1", "mc", { priority: 3 });
    const f = fakeFetch({
      [`${A}/chat/completions`]: status(402),
      [`${B}/chat/completions`]: status(403),
      "https://c.test/v1/chat/completions": ok(),
    });
    await call(db, f);
    expect(keyOf(db, a).status).toBe("disabled");
    expect(model(db, b).status).toBe("disabled");
    expect(keyOf(db, b).status).toBe("active");
  });

  it("503, a thrown network error and an empty reply all cool down 30 s and fall over", async () => {
    const db = openDb(":memory:");
    const a = seed(db, A, "ma", { priority: 1 });
    const b = seed(db, B, "mb", { priority: 2 });
    const c = seed(db, "https://c.test/v1", "mc", { priority: 3 });
    seed(db, "https://d.test/v1", "md", { priority: 4 });
    const f = fakeFetch({
      [`${A}/chat/completions`]: status(503, "overloaded"),
      [`${B}/chat/completions`]: () => {
        throw new TypeError("fetch failed");
      },
      "https://c.test/v1/chat/completions": () => Response.json({ choices: [{ message: { content: "  " } }] }),
      "https://d.test/v1/chat/completions": ok("finally"),
    });

    const r = await call(db, f);

    expect(r).toMatchObject({ text: "finally", attempts: 4 });
    for (const id of [a, b, c]) {
      expect(model(db, id).status).toBe("cooling_down");
      expect(secondsFromNow(model(db, id).cooldown_until)).toBe(30);
    }
    expect(String(model(db, b).last_error)).toContain("connection error");
  });

  it("400 is reported as is: no penalty and no retry on another provider", async () => {
    const db = openDb(":memory:");
    const a = seed(db, A, "ma", { priority: 1 });
    seed(db, B, "mb", { priority: 2 });
    const f = fakeFetch({ [`${A}/chat/completions`]: status(400, '{"error":"bad messages"}'), [`${B}/chat/completions`]: ok() });

    await expect(call(db, f)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("bad messages") });

    expect(f.count(`${B}/chat/completions`)).toBe(0);
    expect(model(db, a).status).toBe("active");
  });

  it("says when every model is exhausted and when the first comes back", async () => {
    const db = openDb(":memory:");
    seed(db, A, "ma", { priority: 1 });
    seed(db, B, "mb", { priority: 2 });
    const f = fakeFetch({ [`${A}/chat/completions`]: status(429, "", { "Retry-After": "90" }), [`${B}/chat/completions`]: status(503) });

    const err = await call(db, f).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RouterError);
    expect((err as RouterError).status).toBe(503);
    expect((err as RouterError).message).toContain("10:00 UTC"); // B comes back first, 30 s after NOW

    const again = await call(db, f).catch((e: unknown) => e);
    expect((again as RouterError).message).toContain("cooling down");
  });

  it("explains an empty pool", async () => {
    const db = openDb(":memory:");
    await expect(call(db, fakeFetch({}))).rejects.toThrow(/No models are configured/);
  });

  it("clears an expired cooldown on success", async () => {
    const db = openDb(":memory:");
    const a = seed(db, A, "ma");
    db.prepare("UPDATE llm_models SET status = 'cooling_down', cooldown_until = ?, last_error = 'x' WHERE id = ?").run("2026-11-24T09:59:00.000Z", a);
    await call(db, fakeFetch({ [`${A}/chat/completions`]: ok() }));
    expect(model(db, a)).toMatchObject({ status: "active", cooldown_until: null, last_error: null });
  });

  it("logs every request with the fallback reason", async () => {
    const db = openDb(":memory:");
    seed(db, A, "ma", { priority: 1, name: "Alpha" });
    seed(db, B, "mb", { priority: 2, name: "Beta" });
    await call(db, fakeFetch({ [`${A}/chat/completions`]: status(429), [`${B}/chat/completions`]: ok() }));
    const [log] = getRouterState(db).logs;
    expect(log).toMatchObject({ provider: "Beta", model: "mb", status_code: 200, attempts: 2, role: "worker" });
    expect(log.note).toContain("Alpha/ma");
  });

  it("RoutedLlm passes the agent's request through the pool", async () => {
    const db = openDb(":memory:");
    seed(db, A, "ma");
    const llm = new RoutedLlm(db, fakeFetch({ [`${A}/chat/completions`]: ok("from pool") }).fn);
    expect(await llm.complete({ role: "triage", messages: MSG })).toBe("from pool");
  });
});

describe("strategies and controls", () => {
  const pool = () => {
    const db = openDb(":memory:");
    const hosts = ["https://a.test/v1", "https://b.test/v1", "https://c.test/v1"];
    const ids = hosts.map((h, i) => seed(db, h, `m${i}`, { priority: 50 - i * 10 }));
    const f = fakeFetch(Object.fromEntries(hosts.map((h, i) => [`${h}/chat/completions`, ok(`m${i}`)])));
    return { db, ids, f };
  };

  it("waterfall always picks the lowest priority number", async () => {
    const { db, f } = pool();
    const picks = [];
    for (let i = 0; i < 3; i++) picks.push((await call(db, f)).model);
    expect(picks).toEqual(["m2", "m2", "m2"]);
  });

  it("round-robin rotates through the pool", async () => {
    const { db, f } = pool();
    setStrategy(db, "round_robin");
    const picks = [];
    for (let i = 0; i < 4; i++) picks.push((await call(db, f)).model);
    expect(picks).toEqual(["m0", "m1", "m2", "m0"]);
  });

  it("round-robin still fails over", async () => {
    const db = openDb(":memory:");
    seed(db, A, "m0");
    seed(db, B, "m1");
    setStrategy(db, "round_robin");
    const f = fakeFetch({ [`${A}/chat/completions`]: status(429), [`${B}/chat/completions`]: ok() });
    expect((await call(db, f)).model).toBe("m1");
  });

  it("rejects an unknown strategy", () => {
    expect(() => setStrategy(openDb(":memory:"), "random")).toThrow(RouterError);
  });

  it("toggling a model off removes it; toggling on retries it; priority reorders", async () => {
    const { db, ids, f } = pool();
    patchModel(db, ids[2], { enabled: false });
    expect((await call(db, f)).model).toBe("m1");
    patchModel(db, ids[2], { enabled: true });
    expect((await call(db, f)).model).toBe("m2");
    patchModel(db, ids[0], { priority: 0 });
    expect((await call(db, f)).model).toBe("m0");
  });

  it("re-enabling clears a model's cooldown and error", () => {
    const { db, ids } = pool();
    db.prepare("UPDATE llm_models SET enabled = 0, status = 'disabled', last_error = 'HTTP 403' WHERE id = ?").run(ids[0]);
    patchModel(db, ids[0], { enabled: true });
    expect(model(db, ids[0])).toMatchObject({ enabled: 1, status: "active", last_error: null });
  });

  it("reset cooldowns makes cooling models eligible again and counts them", async () => {
    const db = openDb(":memory:");
    const a = seed(db, A, "ma", { priority: 1 });
    seed(db, B, "mb", { priority: 2 });
    const f = fakeFetch({ [`${A}/chat/completions`]: [status(429), ok("ma")], [`${B}/chat/completions`]: ok("mb") });
    await call(db, f);
    expect(resetCooldowns(db)).toBe(1);
    expect(model(db, a).status).toBe("active");
    expect((await call(db, f)).model).toBe("ma");
  });

  it("pool health counts usable and cooling models", async () => {
    const db = openDb(":memory:");
    seed(db, A, "ma", { priority: 1 });
    seed(db, B, "mb", { priority: 2 });
    expect(poolHealth(db, NOW)).toMatchObject({ total: 2, usable: 2, cooling: 0 });
    await call(db, fakeFetch({ [`${A}/chat/completions`]: status(429), [`${B}/chat/completions`]: ok() }));
    expect(poolHealth(db, NOW)).toMatchObject({ total: 2, usable: 1, cooling: 1 });
  });
});

describe("keys, providers and model sync", () => {
  const OR = "https://openrouter.ai/api/v1";
  const add = (db: Db, extra: Partial<Parameters<typeof addKey>[1]> = {}) =>
    addKey(db, { preset: "openrouter", label: "main", api_key: "sk-or-v1-abcdef123456", ...extra }).id;

  it("masks keys everywhere the UI can see them", () => {
    const db = openDb(":memory:");
    add(db);
    const json = JSON.stringify(getRouterState(db));
    expect(json).not.toContain("abcdef123456");
    expect(getRouterState(db).providers[0].keys[0].masked_key).toBe("sk-…3456");
  });

  it("puts two keys for the same provider under one provider", () => {
    const db = openDb(":memory:");
    add(db);
    add(db, { label: "second", api_key: "sk-other-key-9999" });
    const { providers } = getRouterState(db);
    expect(providers).toHaveLength(1);
    expect(providers[0].keys).toHaveLength(2);
  });

  it("requires a base URL for custom providers and trims the trailing slash", () => {
    const db = openDb(":memory:");
    expect(() => addKey(db, { preset: "custom", label: "x", api_key: "k" })).toThrow(/base URL/);
    addKey(db, { preset: "custom", label: "x", api_key: "k", base_url: "http://localhost:11434/v1/", name: "Ollama" });
    expect(getRouterState(db).providers[0]).toMatchObject({ base_url: "http://localhost:11434/v1", name: "Ollama" });
  });

  it("filters non-chat models", () => {
    for (const bad of ["text-embedding-004", "nomic-embed-text", "whisper-large-v3", "playai-tts", "dall-e-3", "omni-moderation-latest", "gpt-4o-audio-preview"]) {
      expect(isChatModel({ id: bad }), bad).toBe(false);
    }
    expect(isChatModel({ id: "llama-3.3-70b" })).toBe(true);
    expect(isChatModel({ id: "x/img", architecture: { output_modalities: ["image"] } })).toBe(false);
    expect(isChatModel({ id: "x/img2", architecture: { modality: "text->image" } })).toBe(false);
  });

  it("sync adds chat models, keeps user edits, and removes models gone upstream", async () => {
    const db = openDb(":memory:");
    const key = add(db);
    const listing = (ids: string[]) => ({ [`${OR}/models`]: () => Response.json({ data: ids.map((id) => ({ id })) }) });

    const f1 = fakeFetch(listing(["meta/llama-3:free", "openai/text-embedding-3-small", "openai/gpt-4o"]));
    expect(await syncKey(db, key, f1.fn)).toEqual({ added: 2, kept: 0, removed: 0, total: 2 });
    expect((f1.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-v1-abcdef123456");

    const llama = getRouterState(db).models.find((m) => m.model_id === "meta/llama-3:free")!;
    patchModel(db, llama.id, { priority: 7 });
    expect(await syncKey(db, key, fakeFetch(listing(["meta/llama-3:free"])).fn)).toEqual({ added: 0, kept: 1, removed: 1, total: 1 });
    expect(getRouterState(db).models.map((m) => [m.model_id, m.priority])).toEqual([["meta/llama-3:free", 7]]);
  });

  it("OpenRouter free-only keeps just :free models", async () => {
    const db = openDb(":memory:");
    const key = add(db);
    patchProvider(db, getRouterState(db).providers[0].id, { free_only: true });
    const f = fakeFetch({ [`${OR}/models`]: () => Response.json({ data: [{ id: "meta/llama-3:free" }, { id: "openai/gpt-4o" }] }) });
    await syncKey(db, key, f.fn);
    expect(getRouterState(db).models.map((m) => m.model_id)).toEqual(["meta/llama-3:free"]);
  });

  it("records a sync failure on the key and reports it", async () => {
    const db = openDb(":memory:");
    const key = add(db);
    const f = fakeFetch({ [`${OR}/models`]: status(401, "nope") });
    await expect(syncKey(db, key, f.fn)).rejects.toThrow(/401/);
    expect(getRouterState(db).providers[0].keys[0].last_error).toContain("401");
  });

  it("deleting a key removes its models and the provider when it was the last key", async () => {
    const db = openDb(":memory:");
    const key = add(db);
    await syncKey(db, key, fakeFetch({ [`${OR}/models`]: () => Response.json({ data: [{ id: "meta/llama-3:free" }] }) }).fn);
    deleteKey(db, key);
    expect(getRouterState(db)).toMatchObject({ providers: [], models: [] });
  });
});
