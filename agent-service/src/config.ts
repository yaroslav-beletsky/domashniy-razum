import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SECRETS_DIR = process.env.AGENT_SECRETS_DIR ?? "secrets/agent";

function ensureDir(p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function loadPepper(): string {
  if (process.env.KEY_PEPPER) return process.env.KEY_PEPPER;
  const pepperFile = process.env.KEY_PEPPER_FILE ?? path.join(SECRETS_DIR, ".pepper");
  try {
    const v = fs.readFileSync(pepperFile, "utf8").trim();
    if (v) return v;
  } catch {
    /* first boot */
  }
  const pepper = crypto.randomBytes(32).toString("hex");
  ensureDir(pepperFile);
  fs.writeFileSync(pepperFile, pepper, { mode: 0o600 });
  return pepper;
}

export const config = {
  port: Number(process.env.PORT ?? 4100),
  host: process.env.HOST ?? "0.0.0.0",
  litellmBaseUrl: (process.env.LITELLM_BASE_URL ?? "http://litellm:4000/v1").replace(/\/+$/, ""),
  litellmApiKey: process.env.LITELLM_API_KEY ?? "",
  adminToken: process.env.AGENT_ADMIN_TOKEN ?? "",
  dbPath: process.env.AGENT_DB_PATH ?? path.join(SECRETS_DIR, "agent.db"),
  secretsFile: process.env.AGENT_SECRETS_FILE ?? path.join(SECRETS_DIR, "mcp.env"),
  stdioAllow: (process.env.MCP_STDIO_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  pepper: loadPepper(),
  healthIntervalMs: Number(process.env.MCP_HEALTH_INTERVAL_MS ?? 30_000),
};

export function assertBootConfig() {
  const missing: string[] = [];
  if (!config.litellmApiKey) missing.push("LITELLM_API_KEY");
  if (!config.adminToken) missing.push("AGENT_ADMIN_TOKEN");
  if (missing.length) {
    console.warn(`[config] WARNING: missing env: ${missing.join(", ")} — related features will fail`);
  }
}
