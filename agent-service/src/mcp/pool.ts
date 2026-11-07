import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { db, audit, type McpServerRow } from "../db.js";
import { mcpHeaders, stdioSpec, stdioEnv } from "./tools.js";

const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;

export interface CachedTool {
  name: string; // server__tool
  tool: string; // bare tool name on server
  description: string;
  schema: unknown;
}

interface Conn {
  client: Client;
  transport: Transport;
  failStreak: number;
  circuitOpenUntil: number;
}

const conns = new Map<number, Conn>();
const connecting = new Map<number, Promise<Conn>>();

const qServer = db.prepare("SELECT * FROM mcp_servers WHERE id = ?");
const updStatus = db.prepare(
  "UPDATE mcp_servers SET status = ?, tools_cache = ?, last_check_at = ? WHERE id = ?"
);

export function getServer(id: number): McpServerRow | undefined {
  return qServer.get(id) as McpServerRow | undefined;
}

export function listServers(): McpServerRow[] {
  return db.prepare("SELECT * FROM mcp_servers ORDER BY id").all() as McpServerRow[];
}

function isCircuitOpen(conn: Conn): boolean {
  return conn.circuitOpenUntil > Date.now();
}

async function connect(server: McpServerRow): Promise<Conn> {
  const pending = connecting.get(server.id);
  if (pending) return pending;

  const p = (async () => {
    const client = new Client(
      { name: "station-llm-agent", version: "0.1.0" },
      { capabilities: {} }
    );
    let transport: Transport;
    if (server.transport === "http") {
      if (!server.url) throw new Error("http server missing url");
      transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: mcpHeaders(server) },
      });
    } else if (server.transport === "sse") {
      if (!server.url) throw new Error("sse server missing url");
      transport = new SSEClientTransport(new URL(server.url), {
        requestInit: { headers: mcpHeaders(server) },
      });
    } else {
      // stdio via sandboxed docker run
      const spec = stdioSpec(server);
      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );
      const env = stdioEnv(server);
      transport = new StdioClientTransport({
        command: "docker",
        args: [
          "run", "--rm", "-i",
          "--read-only", "--cap-drop", "ALL", "--memory", "256m",
          "--network", "home",
          ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
          spec.image,
          ...spec.args,
        ],
        env: { ...process.env, ...env } as Record<string, string>,
        stderr: "pipe",
      });
    }
    await client.connect(transport);
    const conn: Conn = { client, transport, failStreak: 0, circuitOpenUntil: 0 };
    conns.set(server.id, conn);
    return conn;
  })().catch((e) => {
    conns.delete(server.id);
    throw e;
  }).finally(() => connecting.delete(server.id));

  connecting.set(server.id, p);
  return p;
}

async function ensureConn(server: McpServerRow): Promise<Conn> {
  const existing = conns.get(server.id);
  if (existing && !isCircuitOpen(existing)) return existing;
  if (existing && isCircuitOpen(existing)) {
    throw new Error(`server ${server.name}: circuit open`);
  }
  return connect(server);
}

async function recordFailure(serverId: number) {
  const conn = conns.get(serverId);
  if (!conn) return;
  conn.failStreak++;
  if (conn.failStreak >= CIRCUIT_THRESHOLD) {
    conn.circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    conn.failStreak = 0;
    try {
      await conn.client.close();
    } catch {
      /* ignore */
    }
    conns.delete(serverId);
    updStatus.run("circuit_open", null, Date.now(), serverId);
  }
}

function recordSuccess(serverId: number) {
  const conn = conns.get(serverId);
  if (conn) conn.failStreak = 0;
}

/** Refresh tools cache for a server. Returns cached tools. */
export async function refreshServer(id: number): Promise<CachedTool[]> {
  const server = getServer(id);
  if (!server) throw new Error(`mcp server ${id} not found`);
  const t0 = Date.now();
  try {
    const conn = await ensureConn(server);
    const res = await conn.client.listTools({ timeout: server.timeout_ms });
    recordSuccess(id);
    const tools: CachedTool[] = (res.tools ?? []).map((t) => ({
      name: `${server.name}__${t.name}`,
      tool: t.name,
      description: t.description ?? "",
      schema: t.inputSchema ?? { type: "object" },
    }));
    updStatus.run("ok", JSON.stringify(tools), Date.now(), id);
    audit("mcp.refresh", { server: server.name, tools: tools.length, ms: Date.now() - t0 });
    return tools;
  } catch (e) {
    await recordFailure(id);
    updStatus.run("error", null, Date.now(), id);
    audit("mcp.refresh_error", { server: server.name, error: String(e).slice(0, 200) });
    throw e;
  }
}

export function cachedTools(server: McpServerRow): CachedTool[] {
  if (!server.tools_cache) return [];
  try {
    return JSON.parse(server.tools_cache);
  } catch {
    return [];
  }
}

export interface ToolCallOutcome {
  ok: boolean;
  ms: number;
  text: string;
}

export async function callTool(
  serverId: number,
  tool: string,
  args: unknown,
  timeoutMs: number
): Promise<ToolCallOutcome> {
  const t0 = Date.now();
  const server = getServer(serverId);
  if (!server) return { ok: false, ms: 0, text: "server not found" };
  if (!server.enabled) return { ok: false, ms: 0, text: `server ${server.name} disabled` };
  try {
    const conn = await ensureConn(server);
    const res = await conn.client.callTool({ name: tool, arguments: args as Record<string, unknown> }, undefined, {
      timeout: timeoutMs,
    });
    recordSuccess(serverId);
    const text =
      (res.content ?? [])
        .map((c: any) => (c.type === "text" ? c.text : c.type === "resource" ? `[resource ${c.uri}]` : ""))
        .filter(Boolean)
        .join("\n") || JSON.stringify(res.structuredContent ?? res);
    return { ok: !res.isError, ms: Date.now() - t0, text };
  } catch (e) {
    await recordFailure(serverId);
    return { ok: false, ms: Date.now() - t0, text: `tool error: ${String(e).slice(0, 300)}` };
  }
}

/** Periodic health: refresh tools cache for enabled servers. */
export function startHealthLoop(intervalMs: number) {
  const tick = async () => {
    for (const s of listServers()) {
      if (!s.enabled) continue;
      try {
        await refreshServer(s.id);
      } catch {
        /* already audited */
      }
    }
  };
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), intervalMs).unref();
  }, 3000).unref();
}

export async function closeAll() {
  for (const [, conn] of conns) {
    try {
      await conn.client.close();
    } catch {
      /* ignore */
    }
  }
  conns.clear();
}

/** Map tool name "server__tool" -> { serverId, serverName, tool }. */
export function resolveToolName(
  fullName: string,
  servers: McpServerRow[]
): { server: McpServerRow; tool: string } | null {
  const idx = fullName.indexOf("__");
  if (idx <= 0) return null;
  const serverName = fullName.slice(0, idx);
  const tool = fullName.slice(idx + 2);
  const server = servers.find((s) => s.name === serverName);
  if (!server) return null;
  return { server, tool };
}
