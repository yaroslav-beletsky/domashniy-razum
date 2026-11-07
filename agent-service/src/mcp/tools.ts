import type { McpServerRow } from "../db.js";
import { getSecret } from "../secrets.js";
import { config } from "../config.js";

/** Compress any tool result: drop nulls, cap arrays at 5, stringify+truncate. */
export function compress(value: unknown, budget = 1500): string {
  const slim = (v: any, depth: number): any => {
    if (v === null || v === undefined) return undefined;
    if (depth > 6) return "…";
    if (Array.isArray(v)) {
      const items = v.slice(0, 5).map((x) => slim(x, depth + 1)).filter((x) => x !== undefined);
      if (v.length > 5) items.push(`…(+${v.length - 5})`);
      return items;
    }
    if (typeof v === "object") {
      const out: Record<string, any> = {};
      for (const [k, val] of Object.entries(v)) {
        const s = slim(val, depth + 1);
        if (s !== undefined) out[k] = s;
      }
      return out;
    }
    return v;
  };
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(slim(value, 0));
  } catch {
    s = String(value);
  }
  if (s.length > budget) s = s.slice(0, budget - 20) + "…[truncated]";
  return s;
}

/** Round budget across tool results of one round. */
export function compressRound(results: string[], budget = 4000): string[] {
  if (results.reduce((a, b) => a + b.length, 0) <= budget) return results;
  const per = Math.max(200, Math.floor(budget / results.length) - 20);
  return results.map((r) => (r.length > per ? r.slice(0, per) + "…[cut]" : r));
}

export function dedupKey(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(args)}`;
}

/** Resolve HTTP headers for an http/sse MCP server from its secret_refs. */
export function mcpHeaders(server: McpServerRow): Record<string, string> {
  let refs: string[] = [];
  try {
    refs = JSON.parse(server.secret_refs);
  } catch {
    /* ignore */
  }
  const headers: Record<string, string> = {};
  for (const ref of refs) {
    if (!/^[A-Za-z-]+$/.test(ref)) continue; // header names only
    const val = getSecret(ref);
    if (val !== undefined) headers[ref] = val;
  }
  return headers;
}

/** Parse stdio cmd JSON: {"image":"...","args":[...]} with allowlist check. */
export function stdioSpec(server: McpServerRow): { image: string; args: string[] } {
  const parsed = JSON.parse(server.cmd ?? "{}");
  const image = String(parsed.image ?? "");
  const args = Array.isArray(parsed.args) ? parsed.args.map(String) : [];
  if (!image) throw new Error("stdio server missing cmd.image");
  if (config.stdioAllow.length === 0 || !config.stdioAllow.includes(image)) {
    throw new Error(`stdio image not in MCP_STDIO_ALLOW: ${image}`);
  }
  return { image, args };
}

/** Env vars for stdio container from secret_refs. */
export function stdioEnv(server: McpServerRow): Record<string, string> {
  let refs: string[] = [];
  try {
    refs = JSON.parse(server.secret_refs);
  } catch {
    /* ignore */
  }
  const env: Record<string, string> = {};
  for (const ref of refs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) continue; // env names only (no dashes)
    const val = getSecret(ref);
    if (val !== undefined) env[ref] = val;
  }
  return env;
}
