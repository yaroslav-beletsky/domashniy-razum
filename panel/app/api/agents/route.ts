// Список и создание агентов. Токен admin API держит сервер панели.
import { NextRequest, NextResponse } from "next/server";
import { agentFetch, normalizeAgent } from "@/lib/agentApi";
import { badJson, readJson, respond } from "@/lib/agentRoutes";
import { getAllMeta, setMeta } from "@/lib/agentMeta";
import { agentTitle, slugify, type Agent, type AgentView, type McpServer } from "@/lib/agentTypes";
import { deviceToId, listStations } from "@/lib/stationsStore";
import { defaultName } from "@/lib/stationsStore";

export const dynamic = "force-dynamic";

interface SvcStation {
  id: number;
  device: string;
  agent_id: number | null;
  agent_slug: string | null;
}

export async function GET() {
  const [ag, mcp, st] = await Promise.all([
    agentFetch<Record<string, unknown>[]>("/agents"),
    agentFetch<McpServer[]>("/mcp"),
    agentFetch<SvcStation[]>("/stations"),
  ]);
  if (!ag.ok) return respond(ag);
  const metas = getAllMeta();
  const servers = mcp.ok ? (mcp.data ?? []) : [];
  const stations = st.ok ? (st.data ?? []) : [];
  const names = new Map(listStations().map((s) => [deviceToId(s.device), s.name ?? defaultName(s.device)]));
  const errServers = servers.filter((s) => s.enabled && s.status !== "ok" && s.status !== "unknown").length;

  const agents: AgentView[] = (ag.data ?? []).map((raw) => {
    const a = normalizeAgent(raw);
    const meta = metas[a.slug] ?? {};
    const all = a.tools_enabled.includes("*");
    const toolCount = all ? 1 + servers.filter((s) => s.enabled).reduce((n, s) => n + s.tools, 0) : a.tools_enabled.length;
    const used = new Set(a.tools_enabled.map((t) => t.split("__")[0]));
    const mcpTotal = all ? servers.filter((s) => s.enabled).length : servers.filter((s) => used.has(s.name)).length;
    const mcpErr = all
      ? errServers
      : servers.filter((s) => used.has(s.name) && s.enabled && s.status !== "ok" && s.status !== "unknown").length;
    const rooms = stations.filter((s) => s.agent_id === a.id).map((s) => names.get(s.device) ?? s.device);
    return { ...a, meta, title: agentTitle(a, meta), toolCount, mcpTotal, mcpErr, rooms };
  });
  return NextResponse.json({
    ok: true,
    agents,
    mcp: { total: servers.length, enabled: servers.filter((s) => s.enabled).length, errors: errServers, reachable: mcp.ok },
    bound: stations.filter((s) => s.agent_id !== null).length,
  });
}

/** Создать агента: { name, model?, system_prompt?, tools_enabled?, avatar?, description? } */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return badJson();
  const name = String(body.name ?? "").trim().slice(0, 32);
  if (!name) return NextResponse.json({ ok: false, error: "нужно имя агента" }, { status: 400 });
  const base = typeof body.slug === "string" && body.slug ? body.slug : slugify(name);
  if (!base) return NextResponse.json({ ok: false, error: "не удалось получить slug из имени — задайте латиницей" }, { status: 400 });

  // slug уникален в сервисе: при занятости добавляем -2, -3…
  const existing = await agentFetch<Array<{ slug: string }>>("/agents");
  if (!existing.ok) return respond(existing);
  const taken = new Set((existing.data ?? []).map((a) => a.slug));
  let slug = base;
  for (let i = 2; taken.has(slug) && i < 100; i++) slug = `${base}-${i}`.slice(0, 60);

  const payload: Record<string, unknown> = {
    slug,
    model: String(body.model || "cp-self-zai-glm-5.3-flash"),
    system_prompt: String(body.system_prompt ?? ""),
    tools_enabled: Array.isArray(body.tools_enabled) ? body.tools_enabled : [],
  };
  const r = await agentFetch<Record<string, unknown>>("/agents", { method: "POST", body: payload });
  if (!r.ok) return respond(r);
  const agent: Agent = normalizeAgent(r.data ?? {});
  const meta = setMeta(agent.slug, { name, avatar: body.avatar, description: body.description });
  return NextResponse.json({ ok: true, agent: { ...agent, meta, title: agentTitle(agent, meta) } }, { status: 201 });
}

