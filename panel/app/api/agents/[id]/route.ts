// Один агент: чтение, правка (с If-Match по version), удаление. `id` — число или slug.
import { NextRequest, NextResponse } from "next/server";
import { agentFetch, normalizeAgent, resolveAgentId } from "@/lib/agentApi";
import { badJson, notFound, readJson, respond } from "@/lib/agentRoutes";
import { deleteMeta, getMeta, setMeta } from "@/lib/agentMeta";
import { agentTitle } from "@/lib/agentTypes";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const id = await resolveAgentId((await ctx.params).id);
  if (id === null) return notFound("агент не найден");
  const r = await agentFetch<Record<string, unknown>>(`/agents/${id}`);
  return respond(r, (d) => {
    const agent = normalizeAgent(d);
    const meta = getMeta(agent.slug);
    return { agent: { ...agent, meta, title: agentTitle(agent, meta) } };
  });
}

const PATCHABLE = ["slug", "system_prompt", "model", "fallback_model", "tools_enabled", "max_rounds", "budget_ms", "max_tokens", "memory_turns", "memory_ttl_s"];

/** { version?, meta?: {name,avatar,description}, …поля агента }. 409 при расхождении version. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const id = await resolveAgentId((await ctx.params).id);
  if (id === null) return notFound("агент не найден");
  const body = await readJson(req);
  if (!body) return badJson();

  const cur = await agentFetch<Record<string, unknown>>(`/agents/${id}`);
  if (!cur.ok) return respond(cur);
  const slug = String((cur.data as { slug?: unknown }).slug);

  const fields: Record<string, unknown> = {};
  for (const k of PATCHABLE) if (k in body) fields[k] = body[k];
  // slug менять нельзя: на него ссылаются колонки (model=agent:<slug>)
  delete fields.slug;
  // fallback_model: пустая строка/null = «нет запасной» (сервис хранит строку, пустую трактуем как отсутствие)
  if ("fallback_model" in fields && !fields.fallback_model) fields.fallback_model = "";

  let agentRaw: Record<string, unknown> = cur.data as Record<string, unknown>;
  if (Object.keys(fields).length > 0) {
    const version = typeof body.version === "number" ? body.version : undefined;
    const r = await agentFetch<Record<string, unknown>>(`/agents/${id}`, { method: "PATCH", body: fields, ifMatch: version });
    if (!r.ok) return respond(r);
    agentRaw = r.data ?? agentRaw;
  }
  if (body.meta && typeof body.meta === "object") setMeta(slug, body.meta);

  const agent = normalizeAgent(agentRaw);
  const meta = getMeta(slug);
  return NextResponse.json({ ok: true, agent: { ...agent, meta, title: agentTitle(agent, meta) } });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const id = await resolveAgentId((await ctx.params).id);
  if (id === null) return notFound("агент не найден");
  const cur = await agentFetch<{ slug?: string }>(`/agents/${id}`);
  const r = await agentFetch(`/agents/${id}`, { method: "DELETE" });
  if (r.ok && cur.ok && cur.data?.slug) deleteMeta(cur.data.slug);
  return respond(r, () => ({ deleted: id }));
}
