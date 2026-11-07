// Прогон автоматического/полуавтоматического шага мастера. POST {key, step, params?} → SSE:
//   {type:"log", level, text} · {type:"check", id, ok, text} · {type:"done", …} | {type:"error", error}
// По успеху шаг фиксируется (done) и указатель двигается дальше; по отказу — статус error,
// критерий НЕ засчитан, повторный запуск безопасен (шаги идемпотентны: «сначала проверь — потом сделай»).
// Ручные шаги здесь не исполняются — они подтверждаются через /api/wizard/state (action:"confirm").
import { NextRequest, NextResponse } from "next/server";
import { sse, readJson } from "@/lib/agentRoutes";
import { appendLog } from "@/lib/logs";
import { recordEvent } from "@/lib/events";
import { config } from "@/lib/config";
import { applyBridgeChange } from "@/lib/station";
import { normalizeMode } from "@/lib/modes";
import { addStation, deviceToId, listStations, updateStation } from "@/lib/stationsStore";
import { agentFetch, resolveAgentId } from "@/lib/agentApi";
import { bindAgent, ensureSvcStation, mintKey } from "@/lib/agentBind";
import { connectStationAgent } from "@/lib/station";
import { getWizardState, nextStep, setWizardCurrent, setWizardStep, STEP_BY_ID, type WizardStepId } from "@/lib/wizard";
import {
  runAdbRoot,
  runBridgeCheck,
  runClassify,
  runNoupdate,
  runOtaCheck,
  runPersist,
  runStandCheck,
  runStaticIpCheck,
  runTestCheck,
} from "@/lib/wizardExec";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  const key = String(body.key ?? "");
  const step = String(body.step ?? "") as WizardStepId | "classify";
  const st = getWizardState(key);
  if (!st) return NextResponse.json({ ok: false, error: "черновик не найден" }, { status: 404 });
  const def = STEP_BY_ID.get(step === "classify" ? "discover" : step);
  if (!def) return NextResponse.json({ ok: false, error: "неизвестный шаг" }, { status: 400 });
  if (step !== "classify" && def.kind === "manual") {
    return NextResponse.json({ ok: false, error: "ручной шаг подтверждается кнопкой «Готово»" }, { status: 400 });
  }
  const device = st.key;

  return sse(async (send) => {
    const t0 = Date.now();
    const emit = (o: Record<string, unknown>) => send(o);
    setWizardStep(device, step === "classify" ? "discover" : step, { status: "running", note: undefined });
    appendLog("info", "station", `мастер ${device}: шаг «${def.title}» — старт`);

    const finish = (r: { ok: boolean; error?: string; note?: string; extra?: Record<string, unknown> }) => {
      const ms = Date.now() - t0;
      if (r.ok) {
        setWizardStep(device, step === "classify" ? "discover" : step, { status: "done", note: r.note });
        if (step !== "classify") {
          const nxt = nextStep(step);
          if (nxt) setWizardCurrent(device, nxt);
        }
        recordEvent("system", `мастер ${device}: «${def.title}» — готово (${Math.round(ms / 1000)} с)`);
        appendLog("info", "station", `мастер ${device}: «${def.title}» — готово`);
        send({ type: "done", ms, note: r.note, ...r.extra });
      } else {
        setWizardStep(device, step === "classify" ? "discover" : step, { status: "error", note: r.error });
        appendLog("error", "station", `мастер ${device}: «${def.title}» — ${r.error}`);
        send({ type: "error", error: r.error });
      }
    };

    switch (step) {
      case "classify":
        finish(await runClassify(st, emit));
        return;
      case "discover":
        // адрес черновика фиксируется при создании (шаг 1 = выполнен); повторный поиск — кнопка скана
        finish({ ok: true, note: "адрес черновика уже выбран; для повторного поиска используйте «Сканировать сеть» на шаге 1" });
        return;
      case "stand":
        finish(await runStandCheck(emit));
        return;
      case "ota":
        finish(await runOtaCheck(device, emit));
        return;
      case "adbroot":
        finish(await runAdbRoot(device, emit));
        return;
      case "bridge":
        finish(await runBridgeCheck(device, emit));
        return;
      case "persist":
        finish(await runPersist(device, emit));
        return;
      case "staticip":
        finish(await runStaticIpCheck(device, emit));
        return;
      case "noupdate":
        finish(await runNoupdate(device, st.host, emit));
        return;
      case "test":
        finish(await runTestCheck(device, emit));
        return;
      case "mode": {
        const params = (body.params ?? {}) as Record<string, unknown>;
        const mode = params.mode !== undefined ? normalizeMode(String(params.mode)) : undefined;
        const rawMode = params.mode === undefined ? undefined : String(params.mode);
        const model = params.model !== undefined ? String(params.model).trim() : undefined;
        if (rawMode === undefined && model === undefined) return finish({ ok: false, error: "нужен mode и/или model" });
        if (rawMode !== undefined && !mode) return finish({ ok: false, error: "mode: alice | hybrid | llm" });
        if (model !== undefined && !/^[\w./:@+~-]{1,120}$/.test(model)) return finish({ ok: false, error: "недопустимое имя модели" });
        const r = await applyBridgeChange(device, { mode, model }, (s) => emit({ type: "step", id: s.id, label: s.label, index: s.index, total: s.total }));
        if (r.ok) {
          await patchWizard(mode, model);
          finish({ ok: true, extra: { pid: r.pid } });
        } else finish(r);
        return;
      }
      case "register": {
        const params = (body.params ?? {}) as Record<string, unknown>;
        const name = (params.name !== undefined ? String(params.name).trim() : st.name ?? "") || undefined;
        const kind = (params.kind !== undefined ? String(params.kind).trim() : st.kind) || "unknown";
        const agentParam = params.agent !== undefined ? String(params.agent).trim() : "";
        emit({ type: "log", level: "info", text: `регистрирую колонку ${device} в панели` });
        const exists = listStations().some((s) => s.device === device);
        if (!exists) {
          const a = addStation(device, name || undefined, (kind as "max" | "mini" | "lite" | "unknown") || "unknown");
          if (!a.ok) return finish({ ok: false, error: a.error });
        } else if (name) {
          updateStation(device, { name });
        }
        emit({ type: "check", id: "panel", ok: true, text: "колонка в реестре панели" });
        let slug: string | null = null;
        if (agentParam) {
          const agentId = await resolveAgentId(agentParam);
          if (agentId === null) return finish({ ok: false, error: "агент не найден — проверьте имя в разделе «Агенты»" });
          const a = await agentFetch<{ slug: string }>(`/agents/${agentId}`);
          if (!a.ok || !a.data) return finish({ ok: false, error: a.error ?? "agent-service недоступен" });
          slug = a.data.slug;
          emit({ type: "log", level: "info", text: `привязываю агента ${slug}` });
          const svc = await ensureSvcStation(device, { name });
          if (!svc.ok || !svc.station) return finish({ ok: false, error: svc.error ?? "не удалось зарегистрировать колонку в agent-service" });
          const prev = svc.station.agent_id;
          const bound = await bindAgent(svc.station.id, agentId);
          if (!bound.ok) return finish({ ok: false, error: bound.error ?? "не удалось привязать агента" });
          const r = await connectStationAgent(device, { model: `agent:${slug}`, baseUrl: config.agentPublicBase, mintKey: () => mintKey(svc.station!.id) }, (id) => emit({ type: "step", id, label: id }));
          if (!r.ok) {
            await bindAgent(svc.station.id, prev);
            return finish({ ok: false, error: r.error });
          }
          emit({ type: "check", id: "agent", ok: true, text: `агент ${slug} привязан, мост healthy (PID ${r.pid})` });
        } else {
          emit({ type: "log", level: "info", text: "агент не выбран — только карточка в панели; привязку можно сделать позже со страницы колонки" });
        }
        await patchWizard(undefined, undefined, deviceToId(device));
        finish({ ok: true, extra: { registeredId: deviceToId(device), agent: slug } });
        return;
      }
      default:
        finish({ ok: false, error: `шаг «${step}» не исполняется автоматически` });
    }

    async function patchWizard(mode?: string, model?: string, registeredId?: string) {
      const { patchWizardState } = await import("@/lib/wizard");
      const patch: Record<string, unknown> = {};
      if (mode) patch.mode = mode;
      if (model) patch.model = model;
      if (registeredId) patch.registeredId = registeredId;
      if (Object.keys(patch).length) await patchWizardState(device, patch);
    }
  });
}
