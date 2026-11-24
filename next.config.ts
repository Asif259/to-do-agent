import type { NextConfig } from "next";

// better-sqlite3 is a native module; Next must load it at runtime, not bundle it.
const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  // Don't let `next dev` write an AGENTS.md into the project; CLAUDE.md is the instruction file here.
  agentRules: false,
  // A package-lock.json exists in a parent folder; pin the project root so Next doesn't guess.
  turbopack: { root: process.cwd() },
};

export default nextConfig;
