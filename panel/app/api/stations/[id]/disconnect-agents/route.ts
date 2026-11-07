// «Отключить от агента»: base_url/ключ/модель возвращаются из runtime.env.bak-agent на колонке.
// POST {} → SSE как у connect-agents; в конце привязка в agent-service снимается и ключ колонки отзывается.
import { NextRequest } from "next/server";
import { findSvcStation, releaseStation } from "@/lib/agentBind";
import { BIND_LABELS, notFound, sse } from "@/lib/agentRoutes";
import { appendLog } from "@/lib/logs";
import { recordEvent } from "@/lib/events";
import { disconnectStationAgent, type BindStepId } from "@/lib/station";
import { idToDevice } from "@/lib/stationsStore";

export const dynamic = "force-dynamic";
export const maxDuration = 90;
type Ctx = { params: Promise<{ id: string }> };

const ORDER: BindStepId[] = ["write", "check", "restart", "wait"];

export async function POST(_req: NextRequest, ctx: Ctx) {
  const device = idToDevice((await ctx.params).id);
  if (!device) return notFound("колонка не найдена");

  return sse(async (send) => {
    const emit = (id: BindStepId) =>
      send({ type: "step", id, label: BIND_LABELS[id], index: ORDER.indexOf(id) + 1, total: ORDER.length });
    appendLog("info", "station", `${device}: отключаем от агента — старт`);
    const r = await disconnectStationAgent(device, emit);
    if (r.ok) {
      // мост уже вернул прежние base_url/ключ/модель — теперь снимаем привязку и отзываем ключ колонки в сервисе.
      // Ошибка отзыва не откатывает отвязку: только предупреждение в журнале.
      const f = await findSvcStation(device);
      if (f.ok && f.station) {
        const rel = await releaseStation(f.station.id);
        if (!rel.unbound) appendLog("warn", "station", `${device}: привязка в agent-service не снята`);
        if (!rel.revoked) appendLog("warn", "station", `${device}: ключ колонки в agent-service не отозван — ${rel.error ?? "?"}`);
      }
      recordEvent("system", `станция ${device}: отключена от агента, мост healthy (PID ${r.pid})`);
      appendLog("info", "station", `${device}: отключена от агента — готово, PID ${r.pid}`);
      send({ type: "done", pid: r.pid, model: r.model });
    } else {
      recordEvent("system", `станция ${device}: отключение от агента не удалось — ${r.error}`);
      appendLog("error", "station", `${device}: отключение от агента — ${r.error}`);
      send({ type: "error", error: r.error });
    }
  });
}
