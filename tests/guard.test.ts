import { describe, expect, it } from "vitest";
import { guard, type GuardInput } from "../src/lib/guard";

const base: GuardInput = { method: "GET", host: "192.168.1.5:3000", origin: null, cookieToken: null, queryToken: null };
const TOKEN = "a-long-enough-token";

describe("guard", () => {
  it("allows everything on localhost when no token is set", () => {
    expect(guard(base, undefined).action).toBe("allow");
    expect(guard({ ...base, method: "POST", origin: "http://192.168.1.5:3000" }, undefined).action).toBe("allow");
  });

  it("refuses a cross-site write even without a token", () => {
    const r = guard({ ...base, method: "POST", origin: "https://evil.test" }, undefined);
    expect(r).toMatchObject({ action: "deny", status: 403 });
    expect(guard({ ...base, method: "DELETE", origin: "not a url" }, undefined)).toMatchObject({ status: 403 });
  });

  it("reads are not blocked by a foreign Origin", () => {
    expect(guard({ ...base, origin: "https://evil.test" }, undefined).action).toBe("allow");
  });

  it("requires the token when set", () => {
    expect(guard(base, TOKEN)).toMatchObject({ action: "deny", status: 401 });
    expect(guard({ ...base, cookieToken: "wrong" }, TOKEN)).toMatchObject({ status: 401 });
    expect(guard({ ...base, cookieToken: TOKEN }, TOKEN).action).toBe("allow");
  });

  it("a ?token= link logs in on GET only", () => {
    expect(guard({ ...base, queryToken: TOKEN }, TOKEN).action).toBe("login");
    expect(guard({ ...base, queryToken: "nope" }, TOKEN)).toMatchObject({ status: 401 });
    expect(guard({ ...base, method: "POST", queryToken: TOKEN }, TOKEN)).toMatchObject({ status: 401 });
  });

  it("exports valid Next.js proxy and config matcher", async () => {
    const proxyMod = await import("../src/proxy");
    expect(typeof proxyMod.proxy).toBe("function");
    expect(proxyMod.config?.matcher).toBeDefined();
  });
});
