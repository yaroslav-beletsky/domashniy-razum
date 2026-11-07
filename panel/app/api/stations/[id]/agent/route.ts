// Привязка колонки к агенту на стороне agent-service (без записи на колонку).
// GET → { bound: {id,slug}|null, registered }; PUT { agent_id: number|null } → меняет привязку.
// Что колонка реально использует (agent:<slug> в runtime.env), видно по её model в /api/stations/[id].
import { NextRequest, NextResponse } from "next/server";
import { agentFetch } from "@/lib/agentApi";
import { bindAgent, ensureSvcStation, findSvcStation } from "@/lib/agentBind";
import { badJson, notFound, readJson, respond } from "@/lib/agentRoutes";
import { idToDevice } from "@/lib/stationsStore";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const device = idToDevice((await ctx.params).id);
  if (!device) return notFound("колонка не найдена");
  const f = await findSvcStation(device);
  if (!f.ok) return NextResponse.json({ ok: false, error: f.error }, { status: 502 });
  if (!f.station) return NextResponse.json({ ok: true, registered: false, bound: null });
  const bound = f.station.agent_id ? { id: f.station.agent_id, slug: f.station.agent_slug } : null;
  return NextResponse.json({ ok: true, registered: true, bound, hasKey: Boolean(f.station.has_key) });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const device = idToDevice((await ctx.params).id);
  if (!device) return notFound("колонка не найдена");
  const body = await readJson(req);
  if (!body || !("agent_id" in body)) return body ? NextResponse.json({ ok: false, error: "нужен agent_id (число или null)" }, { status: 400 }) : badJson();
  const agentId = body.agent_id === null ? null : Number(body.agent_id);
  if (agentId !== null && !Number.isInteger(agentId)) return NextResponse.json({ ok: false, error: "agent_id: число или null" }, { status: 400 });
  if (agentId !== null) {
    const a = await agentFetch(`/agents/${agentId}`);
    if (!a.ok) return respond(a);
  }
  const e = await ensureSvcStation(device);
  if (!e.ok || !e.station) return NextResponse.json({ ok: false, error: e.error }, { status: 502 });
  const r = await bindAgent(e.station.id, agentId);
  return respond(r, () => ({ agent_id: agentId }));
}
