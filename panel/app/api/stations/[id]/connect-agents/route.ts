// «Подключить к агенту». POST { agent: <slug|id> } → SSE:
//   {type:"step", id, label, index, total} … {type:"done", pid, model} | {type:"error", error}
// 1) станция в agent-service (создаётся при первом подключении) + привязка к агенту;
// 2) выпуск ключа колонки (показывается один раз — прямо в runtime.env, в ответ и в лог не попадает);
// 3) runtime.env.bak-agent ← исходные base_url/ключ/модель; прописываем agent-service и model=agent:<slug>;
// 4) check → restart → ждём healthy. Любой отказ откатывает runtime.env и привязку.
import { NextRequest, NextResponse } from "next/server";
import { agentFetch, resolveAgentId } from "@/lib/agentApi";
import { bindAgent, ensureSvcStation, mintKey } from "@/lib/agentBind";
import { badJson, BIND_LABELS, notFound, readJson, sse } from "@/lib/agentRoutes";
import { config } from "@/lib/config";
import { appendLog } from "@/lib/logs";
import { recordEvent } from "@/lib/events";
import { connectStationAgent, type BindStepId } from "@/lib/station";
import { idToDevice, listStations } from "@/lib/stationsStore";

export const dynamic = "force-dynamic";
export const maxDuration = 90;
type Ctx = { params: Promise<{ id: string }> };

const ORDER_KEY: BindStepId[] = ["key", "write", "check", "restart", "wait"];

export async function POST(req: NextRequest, ctx: Ctx) {
  const device = idToDevice((await ctx.params).id);
  if (!device) return notFound("колонка не найдена");
  const body = await readJson(req);
  if (!body) return badJson();
  const agentParam = String(body.agent ?? "");
  const agentId = await resolveAgentId(agentParam);
  if (agentId === null) return notFound("агент не найден");
  const a = await agentFetch<{ slug: string }>(`/agents/${agentId}`);
  if (!a.ok) return NextResponse.json({ ok: false, error: a.error }, { status: a.status });
  const slug = a.data!.slug;
  const model = `agent:${slug}`;

  return sse(async (send) => {
    const emit = (id: BindStepId) =>
      send({ type: "step", id, label: BIND_LABELS[id], index: ORDER_KEY.indexOf(id) + 1, total: ORDER_KEY.length });
    appendLog("info", "station", `${device}: подключаем к агенту ${slug} — старт`);

    const st = await ensureSvcStation(device, listStations().find((s) => s.device === device));
    if (!st.ok || !st.station) {
      send({ type: "error", error: st.error ?? "не удалось зарегистрировать колонку в agent-service" });
      return;
    }
    const prevAgent = st.station.agent_id;
    const bound = await bindAgent(st.station.id, agentId);
    if (!bound.ok) {
      send({ type: "error", error: bound.error ?? "не удалось привязать агента" });
      return;
    }

    const r = await connectStationAgent(device, { model, baseUrl: config.agentPublicBase, mintKey: () => mintKey(st.station!.id) }, emit);
    if (r.ok) {
      recordEvent("system", `станция ${device}: подключена к агенту ${slug}, мост healthy (PID ${r.pid})`);
      appendLog("info", "station", `${device}: агент ${slug} — готово, PID ${r.pid}`);
      send({ type: "done", pid: r.pid, model, agent: slug });
    } else {
      await bindAgent(st.station.id, prevAgent); // колонка осталась на прежней модели — привязку тоже откатываем
      recordEvent("system", `станция ${device}: подключение к агенту ${slug} не удалось — ${r.error}`);
      appendLog("error", "station", `${device}: агент ${slug} — ${r.error}`);
      send({ type: "error", error: r.error });
    }
  });
}
