// Serve on the local network (for a phone on the same Wi-Fi). Refuses to start without ACCESS_TOKEN.
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { existsSync, readFileSync } from "node:fs";

for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const mode = process.argv[2] === "start" ? "start" : "dev";
const token = process.env.ACCESS_TOKEN;
if (!token || token.length < 12) {
  console.error("Set ACCESS_TOKEN (12+ characters) in .env.local first. Without it anyone on your Wi-Fi could read and change your tasks.");
  process.exit(1);
}

const port = process.env.PORT || "3000";
const ip = Object.values(networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address;
console.log(`\nOn your phone (same Wi-Fi), open once:\n  http://${ip ?? "<your-mac-ip>"}:${port}/?token=${token}\n`);

spawn("npx", ["next", mode, "-H", "0.0.0.0", "-p", port], { stdio: "inherit", env: process.env }).on("exit", (c) => process.exit(c ?? 0));
