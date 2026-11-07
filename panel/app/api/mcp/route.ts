// MCP-серверы agent-service. Значения секретов никогда не возвращаются — только имена и флаг «задан».
import { NextRequest, NextResponse } from "next/server";
import { agentFetch } from "@/lib/agentApi";
import { badJson, readJson, respond } from "@/lib/agentRoutes";
import type { McpServer } from "@/lib/agentTypes";

export const dynamic = "force-dynamic";

export async function GET() {
  const r = await agentFetch<McpServer[]>("/mcp");
  return respond(r, (d) => ({ servers: d ?? [] }));
}

/**
 * Создать и сразу проверить: { name, transport, url?, cmd?, timeout_ms?, secrets?: [{name,value}] }.
 * Секреты уходят в сервис (PUT …/secrets), в secret_refs попадают только имена.
 * Ответ: { server, check: { ok, tools?, error? } } — сервер сохраняется, даже если проверка не прошла.
 */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return badJson();
  const secrets = Array.isArray(body.secrets)
    ? (body.secrets as Array<{ name?: unknown; value?: unknown }>)
        .filter((s) => typeof s?.name === "string" && s.name && typeof s?.value === "string" && s.value)
        .map((s) => ({ name: String(s.name), value: String(s.value) }))
    : [];
  const payload: Record<string, unknown> = {
    name: body.name,
    transport: body.transport,
    url: body.url || null,
    cmd: body.cmd || null,
    secret_refs: secrets.map((s) => s.name),
    enabled: body.enabled !== false,
  };
  if (body.timeout_ms !== undefined) payload.timeout_ms = body.timeout_ms;

  const created = await agentFetch<McpServer>("/mcp", { method: "POST", body: payload });
  if (!created.ok) return respond(created);
  const id = created.data!.id;

  if (secrets.length) {
    const s = await agentFetch(`/mcp/${id}/secrets`, { method: "PUT", body: { secrets } });
    if (!s.ok) return NextResponse.json({ ok: true, server: created.data, check: { ok: false, error: `секреты не сохранены: ${s.error}` } }, { status: 201 });
  }
  const ref = await agentFetch<{ tools: number }>(`/mcp/${id}/refresh`, { method: "POST", timeoutMs: 20000 });
  const fresh = await agentFetch<McpServer>("/mcp");
  const server = fresh.ok ? (fresh.data as unknown as McpServer[]).find((x) => x.id === id) ?? created.data : created.data;
  return NextResponse.json(
    { ok: true, server, check: ref.ok ? { ok: true, tools: ref.data?.tools ?? 0 } : { ok: false, error: ref.error } },
    { status: 201 },
  );
}
