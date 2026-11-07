// Серверный клиент admin API agent-service. Токен читается из env и наружу не уходит:
// браузер ходит только в route-handlers панели (/api/agents, /api/mcp, /api/stations/[id]/…).
import { agentAdminToken, config } from "./config";
import type { Agent } from "./agentTypes";

export interface AgentCall<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${agentAdminToken()}`, ...extra };
}

export function agentConfigured(): boolean {
  return agentAdminToken().length > 0;
}

/** Достаёт читаемую ошибку из `{error:{message}}` и т.п. Не отдаёт тело ответа целиком. */
function errorText(status: number, body: unknown): string {
  const e = (body as { error?: { message?: unknown } | string } | null)?.error;
  const msg = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : "";
  if (status === 401) return "agent-service отклонил токен панели (401)";
  return (msg || `agent-service: HTTP ${status}`).slice(0, 300);
}

export async function agentFetch<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; ifMatch?: number; timeoutMs?: number } = {},
): Promise<AgentCall<T>> {
  if (!agentConfigured()) return { ok: false, status: 503, error: "AGENT_ADMIN_TOKEN не задан в .env панели" };
  try {
    const res = await fetch(`${config.agentServiceUrl}/admin${path}`, {
      method: init.method ?? "GET",
      headers: headers({
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.ifMatch !== undefined ? { "If-Match": String(init.ifMatch) } : {}),
      }),
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs ?? 10000),
    });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* не JSON */
    }
    if (!res.ok) return { ok: false, status: res.status, error: errorText(res.status, json), data: json as T };
    return { ok: true, status: res.status, data: json as T };
  } catch (e) {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    return { ok: false, status: 502, error: timeout ? "agent-service не ответил вовремя" : "agent-service недоступен" };
  }
}

/** SSE-проход для тест-панели: возвращает ответ апстрима как есть (тело — поток). */
export async function agentStream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  if (!agentConfigured()) {
    return Response.json({ ok: false, error: "AGENT_ADMIN_TOKEN не задан в .env панели" }, { status: 503 });
  }
  try {
    const up = await fetch(`${config.agentServiceUrl}/admin${path}`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      cache: "no-store",
      signal,
    });
    if (!up.ok || !up.body) {
      const j = await up.json().catch(() => null);
      return Response.json({ ok: false, error: errorText(up.status, j) }, { status: up.status || 502 });
    }
    return new Response(up.body, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    });
  } catch {
    return Response.json({ ok: false, error: "agent-service недоступен" }, { status: 502 });
  }
}

/** Агент из ответа POST/PATCH: там tools_enabled — JSON-строка, в GET — массив. */
export function normalizeAgent(a: Record<string, unknown>): Agent {
  let tools: string[] = [];
  const t = a.tools_enabled;
  if (Array.isArray(t)) tools = t.map(String);
  else if (typeof t === "string") {
    try {
      const p = JSON.parse(t);
      if (Array.isArray(p)) tools = p.map(String);
    } catch {
      /* пусто */
    }
  }
  return { ...(a as unknown as Agent), tools_enabled: tools };
}

/** `:id` из URL: число или slug агента → числовой id (или null). */
export async function resolveAgentId(param: string): Promise<number | null> {
  if (/^\d+$/.test(param)) return Number(param);
  if (!/^[a-z0-9][a-z0-9_-]{1,60}$/.test(param)) return null;
  const r = await agentFetch<Array<{ id: number; slug: string }>>("/agents");
  return r.ok ? (r.data?.find((a) => a.slug === param)?.id ?? null) : null;
}
