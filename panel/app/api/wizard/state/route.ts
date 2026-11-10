// Состояние мастера «Добавить колонку».
// GET  ?key=…            → один черновик (+ определения шагов и конфиг мастера)
// GET                    → список черновиков
// POST {action:"create", host, port?, name?, kind?, prep?} → создать черновик
//   (шаг «Поиск» = выполнен; prep.reset/prep.wifi = "done"|"skipped" — отметка
//   шагов подготовки из диалога добавления)
// POST {action:"update", key, name?, kind?, mode?, model?}
// POST {action:"confirm", key, step}   → ручной шаг подтверждён: done + переход дальше
// POST {action:"skip", key, step}      → пропустить (где skippable)
// POST {action:"back", key}            → шаг назад (статус текущего → pending)
// POST {action:"delete", key}          → удалить черновик
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { readJson } from "@/lib/agentRoutes";
import {
  createWizardState,
  deleteWizardState,
  getWizardState,
  listWizardStates,
  nextStep,
  patchWizardState,
  platformForKind,
  prevStep,
  setWizardCurrent,
  setWizardStep,
  STEP_BY_ID,
  WIZARD_STEPS,
  type WizardStepId,
} from "@/lib/wizard";
import { recordEvent } from "@/lib/events";

export const dynamic = "force-dynamic";

function wizardMeta() {
  return {
    steps: WIZARD_STEPS,
    standUrl: config.standBaseUrl,
    // Целевую версию прошивки мастер не хардкодит: стенд сам называет её
    // в check_updates по платформе колонки (мини 2 → .46, Станция 2 → .50).
    subnet: config.wizardLanSubnet,
  };
}

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (key) {
    const st = getWizardState(key);
    if (!st) return NextResponse.json({ ok: false, error: "черновик не найден" }, { status: 404 });
    return NextResponse.json({ ok: true, state: st, ...wizardMeta() });
  }
  return NextResponse.json({ ok: true, states: listWizardStates(), ...wizardMeta() });
}

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  const action = String(body.action ?? "");

  if (action === "create") {
    const rawPrep = (body.prep ?? {}) as { reset?: unknown; wifi?: unknown };
    const normPrep = (v: unknown): "done" | "skipped" | undefined => (v === "done" || v === "skipped" ? v : undefined);
    const prep = { reset: normPrep(rawPrep.reset), wifi: normPrep(rawPrep.wifi) };
    const r = createWizardState(
      String(body.host ?? ""),
      body.port === undefined ? 5555 : Number(body.port),
      String(body.name ?? ""),
      String(body.kind ?? ""),
      prep.reset || prep.wifi ? prep : undefined,
      body.mac === undefined ? undefined : String(body.mac),
    );
    if (!r.ok || !r.key) return NextResponse.json({ ok: false, error: r.error }, { status: 400 });
    recordEvent("system", `мастер: черновик для ${r.key}`);
    return NextResponse.json({ ok: true, key: r.key });
  }

  const key = String(body.key ?? "");
  const st = getWizardState(key);
  if (!st) return NextResponse.json({ ok: false, error: "черновик не найден" }, { status: 404 });

  switch (action) {
    case "update": {
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = String(body.name).trim() || undefined;
      if (body.kind !== undefined) {
        const kind = String(body.kind).trim();
        patch.kind = kind || undefined;
        patch.platform = platformForKind(kind) ?? undefined;
      }
      if (body.mode !== undefined) patch.mode = String(body.mode).trim() || undefined;
      if (body.model !== undefined) patch.model = String(body.model).trim() || undefined;
      if (body.mac !== undefined) patch.mac = String(body.mac).trim().toLowerCase() || undefined;
      if (body.host !== undefined) patch.host = String(body.host).trim() || undefined;
      if (body.lastHost !== undefined) patch.lastHost = String(body.lastHost).trim() || undefined;
      const err = patchWizardState(key, patch);
      return err ? NextResponse.json({ ok: false, error: err }, { status: 500 }) : NextResponse.json({ ok: true });
    }
    case "confirm": {
      const step = String(body.step ?? "") as WizardStepId;
      const def = STEP_BY_ID.get(step);
      if (!def) return NextResponse.json({ ok: false, error: "неизвестный шаг" }, { status: 400 });
      setWizardStep(key, step, { status: "done", note: "подтверждено вручную" });
      const nxt = nextStep(step);
      if (nxt) setWizardCurrent(key, nxt);
      return NextResponse.json({ ok: true, next: nxt });
    }
    case "skip": {
      const step = String(body.step ?? "") as WizardStepId;
      const def = STEP_BY_ID.get(step);
      if (!def) return NextResponse.json({ ok: false, error: "неизвестный шаг" }, { status: 400 });
      if (!def.skippable) {
        return NextResponse.json({ ok: false, error: "этот шаг нельзя пропустить" }, { status: 400 });
      }
      setWizardStep(key, step, { status: "skipped", note: "пропущено пользователем" });
      const nxt = nextStep(step);
      if (nxt) setWizardCurrent(key, nxt);
      return NextResponse.json({ ok: true, next: nxt });
    }
    case "back": {
      const prev = prevStep(st.current);
      if (prev) {
        setWizardCurrent(key, prev);
        const cur = st.steps[st.current];
        if (cur?.status === "pending" || cur?.status === "error") setWizardStep(key, st.current, { status: "pending", note: undefined });
      }
      return NextResponse.json({ ok: true, current: prev ?? st.current });
    }
    case "delete": {
      deleteWizardState(key);
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ ok: false, error: "неизвестное действие" }, { status: 400 });
  }
}
