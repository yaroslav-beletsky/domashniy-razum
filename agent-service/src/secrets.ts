import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * File-backed secret store: KEY=VALUE lines in secrets/agent/mcp.env (0600).
 * DB keeps only secret NAMES (secret_refs); values live here.
 */
let cache: Record<string, string> = {};

export function loadSecrets(): Record<string, string> {
  cache = {};
  try {
    const raw = fs.readFileSync(config.secretsFile, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      cache[t.slice(0, eq).trim()] = t.slice(eq + 1);
    }
  } catch {
    /* file may not exist yet */
  }
  return cache;
}

export function getSecret(name: string): string | undefined {
  return cache[name];
}

export function listSecretNames(): string[] {
  return Object.keys(cache).sort();
}

export function setSecret(name: string, value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) throw new Error(`bad secret name: ${name}`);
  cache[name] = value;
  persist();
}

function persist() {
  ensureSecretsDir();
  const lines = Object.entries(cache).map(([k, v]) => `${k}=${v}`);
  const tmp = config.secretsFile + ".tmp";
  fs.writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, config.secretsFile);
  fs.chmodSync(config.secretsFile, 0o600);
}

export function ensureSecretsDir() {
  fs.mkdirSync(path.dirname(config.secretsFile), { recursive: true });
}

export function secretNamesOnly(names: string[]): { name: string; set: boolean }[] {
  return names.map((n) => ({ name: n, set: cache[n] !== undefined && cache[n] !== "" }));
}
