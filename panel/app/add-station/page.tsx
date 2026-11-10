"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  Loader2,
  Play,
  Plus,
  Radar,
  Trash2,
  Wand2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, postSse } from "@/lib/sseClient";
import type { StepStatus, WizardState, WizardStepDef } from "@/lib/wizard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { WizardStepper } from "@/components/wizard/stepper";
import { AddStationSheet } from "@/components/wizard/add-sheet";
import { KINDS } from "@/components/wizard/discovery";

interface WizardMeta {
  steps: WizardStepDef[];
  standUrl: string;
  subnet: string;
}

interface CheckItem {
  id: string;
  ok: boolean;
  text: string;
}

interface RunState {
  step: string;
  running: boolean;
  checks: CheckItem[];
  lines: { level: string; text: string }[];
  error?: string;
  doneNote?: string;
  /** Текущий адрес, по которому мастер пробует колонку (обновляется при «переезде»). */
  addr?: string;
}

const MODE_LABELS: Record<string, string> = { alice: "Алиса", hybrid: "Гибрид", llm: "Только моя модель" };

function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString("ru-RU", { hour12: false });
}

// ---------- панель шага ----------

function StepPanel({
  state,
  step,
  run,
  onRun,
  onConfirm,
  onSkip,
}: {
  state: WizardState;
  step: WizardStepDef;
  run: RunState | null;
  onRun: (step: string, params?: Record<string, unknown>) => void;
  onConfirm: (step: string) => void;
  onSkip: (step: string) => void;
}) {
  const st = state.steps[step.id];
  const status: StepStatus = run?.step === step.id && run.running ? "running" : (st?.status ?? "pending");
  const [mode, setMode] = useState(state.mode ?? "hybrid");
  const [regName, setRegName] = useState(state.name ?? "");
  const [regKind, setRegKind] = useState(state.kind ?? "unknown");

  const running = run?.step === step.id && run.running;
  const execLabel =
    step.id === "ota"
      ? "Проверить прошивку"
      : step.id === "bridge"
        ? "Проверить/установить мост"
        : step.id === "staticip"
          ? "Показать конфигурацию"
          : step.id === "mode"
            ? "Применить режим"
            : step.id === "register"
              ? "Зарегистрировать и подключить агента"
              : step.id === "test"
                ? "Показать лог моста"
                : "Выполнить";


  const runWithDanger = () => {
    if (step.danger && !window.confirm(`Шаг «${step.title}» меняет системную часть колонки. Откат описан в памятке шага. Продолжить?`)) return;
    onRun(step.id, step.id === "mode" ? { mode } : step.id === "register" ? { name: regName, kind: regKind } : undefined);
  };

  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm font-medium text-zinc-100">
            Шаг {step.n}. {step.title}
          </CardTitle>
          <Badge
            variant="outline"
            className={cn(
              "h-5 px-1.5 font-mono text-[10px]",
              status === "done" && "border-emerald-900 text-emerald-300",
              status === "error" && "border-amber-900 text-amber-300",
              status === "running" && "border-sky-900 text-sky-300",
              (status === "skipped" || status === "pending") && "border-zinc-800 text-zinc-500",
            )}
          >
            {status === "done" ? "готово" : status === "error" ? "ошибка — можно повторить" : status === "running" ? "выполняется" : status === "skipped" ? "пропущен" : "ждёт"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-3">
        <p className="text-[13px] leading-relaxed text-zinc-300">{step.hint}</p>
        {(step.criteria || step.rollback || step.todo) && (
          <details className="mt-1.5 rounded border border-zinc-800 bg-zinc-950/50 px-3 py-1.5">
            <summary className="cursor-pointer select-none text-[11px] text-zinc-500 transition-colors hover:text-zinc-300">
              Критерий готовности, откат
            </summary>
            <div className="mt-1.5 flex flex-col gap-1 font-mono text-[11px] leading-snug text-zinc-500">
              {step.criteria && <div>критерий: {step.criteria}</div>}
              {step.rollback && <div>откат: {step.rollback}</div>}
              {step.todo && <div className="text-amber-500/80">todo: {step.todo}</div>}
            </div>
          </details>
        )}
        {st?.note && <div className="mt-1.5 font-mono text-[10px] text-zinc-500">{st.note}</div>}

        {step.id === "mode" && (
          <div className="mt-3 grid gap-2">
            <div role="radiogroup" aria-label="Режим" className="grid grid-cols-3 gap-1.5">
              {Object.entries(MODE_LABELS).map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={mode === v}
                  onClick={() => setMode(v)}
                  className={cn(
                    "h-11 rounded-md border text-xs transition-colors sm:h-9",
                    mode === v ? "border-zinc-500 bg-zinc-800 text-zinc-50" : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
                  )}
                >
                  {l}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-zinc-500">Модель подставится от единственного агента — выбор здесь не нужен.</p>
          </div>
        )}

        {step.id === "register" && (
          <div className="mt-3 grid gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="wiz-reg-name">Комната</Label>
              <Input id="wiz-reg-name" value={regName} onChange={(e) => setRegName(e.target.value)} maxLength={40} placeholder="Гостиная" className="h-11 sm:h-9" />
            </div>
            <div className="grid gap-1.5">
              <Label>Тип</Label>
              <div role="radiogroup" aria-label="Тип колонки" className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
                {KINDS.map((k) => (
                  <button
                    key={k.v}
                    type="button"
                    role="radio"
                    aria-checked={regKind === k.v}
                    onClick={() => setRegKind(k.v)}
                    className={cn(
                      "h-11 rounded-md border px-1 text-xs transition-colors sm:h-9",
                      regKind === k.v ? "border-zinc-500 bg-zinc-800 text-zinc-50" : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
                    )}
                  >
                    {k.l}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-zinc-500">Агент подключится сам — единственный, без ручного выбора.</p>
          </div>
        )}

        {/* живой прогресс */}
        {run?.step === step.id && (run.checks.length > 0 || run.lines.length > 0) && (
          <div className="mt-3 flex flex-col gap-2">
            {run.checks.map((c) => (
              <div key={c.id} className="flex items-start gap-2 font-mono text-xs">
                {c.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-400" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />}
                <span className={c.ok ? "text-zinc-300" : "text-amber-300"}>{c.text}</span>
              </div>
            ))}
            {run.lines.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded border border-zinc-800 bg-zinc-950/70 p-2 font-mono text-[11px] text-zinc-500">
                {run.lines.slice(-40).map((l, i) => (
                  <div key={i} className={cn(l.level === "err" && "text-amber-400")}>
                    {l.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {run?.step === step.id && run.addr && (
          <div className="mt-2 rounded border border-sky-900/50 bg-sky-950/20 px-3 py-1.5 font-mono text-[11px] text-sky-300">
            пробую адрес: {run.addr}{run.addr !== state.key ? ` (черновик ${state.key} — адрес пере-резолвится при переезде)` : ""}
          </div>
        )}
        {run?.step === step.id && run.error && (
          <p role="alert" className="mt-2 rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
            {run.error}
          </p>
        )}
        {run?.step === step.id && run.doneNote && status === "done" && (
          <p className="mt-2 rounded border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
            Готово{run.doneNote ? `: ${run.doneNote}` : ""}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {step.kind === "manual" ? (
            <Button className="h-11 gap-1.5 sm:h-9" disabled={running} onClick={() => onConfirm(step.id)}>
              {status === "done" ? "Подтверждено" : "Готово"}
              {status === "done" && <CheckCircle2 className="size-4" />}
            </Button>
          ) : (
            <Button className="h-11 gap-1.5 sm:h-9" disabled={running} onClick={runWithDanger}>
              {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {running ? "Выполняется…" : status === "error" ? "Повторить" : execLabel}
            </Button>
          )}
          {step.skippable && status !== "done" && (
            <Button variant="ghost" className="h-11 sm:h-9" disabled={running} onClick={() => onSkip(step.id)}>
              Пропустить
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- страница мастера ----------

export default function AddStationPage() {
  const [meta, setMeta] = useState<WizardMeta | null>(null);
  const [drafts, setDrafts] = useState<WizardState[]>([]);
  const [key, setKey] = useState<string | null>(null);
  const [state, setState] = useState<WizardState | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [classifying, setClassifying] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const j = await api<{ states: WizardState[] } & WizardMeta>("/api/wizard/state");
      setDrafts(j.states);
      setMeta({ steps: j.steps, standUrl: j.standUrl, subnet: j.subnet });
    } catch {
      /* панель недоступна — тихо */
    }
  }, []);

  const refreshState = useCallback(async (k: string) => {
    try {
      const j = await api<{ state: WizardState }>("/api/wizard/state?key=" + encodeURIComponent(k));
      setState(j.state);
    } catch {
      setState(null);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (key) void refreshState(key);
  }, [key, refreshState]);

  // Вход «+ Добавить колонку» со страницы колонок: /add-station?new=1 сразу
  // открывает диалог добавления (инструкция → подготовка → поиск).
  useEffect(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("new") === "1") {
      setSheetOpen(true);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const doRun = useCallback(
    (step: string, params?: Record<string, unknown>) => {
      if (!key) return;
      abort.current?.abort();
      abort.current = new AbortController();
      setRun({ step, running: true, checks: [], lines: [] });
      void postSse(
        "/api/wizard/run",
        { key, step, params },
        (m) => {
          const d = m.data;
          setRun((r) => {
            if (!r) return r;
            if (d.type === "check") {
              const item = { id: String(d.id), ok: Boolean(d.ok), text: String(d.text) };
              const rest = r.checks.filter((c) => c.id !== item.id);
              return { ...r, checks: [...rest, item] };
            }
            if (d.type === "log") return { ...r, lines: [...r.lines, { level: String(d.level ?? "info"), text: String(d.text) }] };
            if (d.type === "step") return { ...r, lines: [...r.lines, { level: "info", text: `${d.label} (${d.index}/${d.total})` }] };
            if (d.type === "addr") return { ...r, addr: String(d.addr) };
            if (d.type === "done") return { ...r, running: false, doneNote: d.note ? String(d.note) : undefined };
            if (d.type === "error") return { ...r, running: false, error: String(d.error) };
            return r;
          });
        },
        abort.current.signal,
      ).then(async () => {
        await refreshState(key);
        await refreshList();
      });
    },
    [key, refreshState, refreshList],
  );

  const confirmStep = useCallback(
    async (step: string) => {
      if (!key) return;
      try {
        await api("/api/wizard/state", { method: "POST", body: { action: "confirm", key, step } });
      } finally {
        await refreshState(key);
      }
    },
    [key, refreshState],
  );

  const skipStep = useCallback(
    async (step: string) => {
      if (!key) return;
      try {
        await api("/api/wizard/state", { method: "POST", body: { action: "skip", key, step } });
      } finally {
        await refreshState(key);
      }
    },
    [key, refreshState],
  );

  const goBack = useCallback(async () => {
    if (!key) return;
    abort.current?.abort();
    setRun(null);
    try {
      await api("/api/wizard/state", { method: "POST", body: { action: "back", key } });
    } finally {
      await refreshState(key);
    }
  }, [key, refreshState]);

  const classify = useCallback(async () => {
    if (!key) return;
    setClassifying(true);
    setRun({ step: "classify", running: true, checks: [], lines: [{ level: "info", text: "определяю состояние колонки…" }] });
    await postSse("/api/wizard/run", { key, step: "classify" }, (m) => {
      const d = m.data;
      setRun((r) => {
        if (!r) return r;
        if (d.type === "check") return { ...r, checks: [...r.checks.filter((c) => c.id !== String(d.id)), { id: String(d.id), ok: Boolean(d.ok), text: String(d.text) }] };
        if (d.type === "log") return { ...r, lines: [...r.lines, { level: String(d.level ?? "info"), text: String(d.text) }] };
        if (d.type === "done") return { ...r, running: false };
        if (d.type === "error") return { ...r, running: false, error: String(d.error) };
        return r;
      });
    }).then(async () => {
      setClassifying(false);
      await refreshState(key);
    });
  }, [key, refreshState]);

  const removeDraft = useCallback(
    async (k: string) => {
      try {
        await api("/api/wizard/state", { method: "POST", body: { action: "delete", key: k } });
      } finally {
        if (key === k) {
          setKey(null);
          setState(null);
          setRun(null);
        }
        await refreshList();
      }
    },
    [key, refreshList],
  );

  const allDone =
    state && meta ? meta.steps.every((s) => ["done", "skipped"].includes(state.steps[s.id]?.status ?? "pending")) : false;
  const currentDef = meta && state ? meta.steps.find((s) => s.id === state.current) : null;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 text-lg font-medium text-zinc-100">
          <Wand2 className="size-4 text-zinc-400" /> Мастер: добавить колонку
        </h1>
        <Badge variant="outline" className="h-5 border-violet-900 px-1.5 font-mono text-[10px] text-violet-300">
          ветка A · локальный мост
        </Badge>
        <span className="font-mono text-[11px] text-zinc-600">
          {state?.platform ? `платформа ${state.platform} · прошивку называет стенд` : "прошивку для модели называет стенд"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {/* Возврат в раздел «Колонки»: мастер больше не в меню, выход нужен на странице. */}
          <Button variant="ghost" className="h-9 gap-1.5 px-3 text-zinc-300" asChild>
            <Link href="/stations">
              <ArrowLeft className="size-4" /> Колонки
            </Link>
          </Button>
          {state && (
            <Button variant="ghost" className="h-9 gap-1.5 px-3 text-zinc-300" onClick={() => void goBack()} disabled={classifying || run?.running}>
              <ChevronLeft className="size-4" /> Назад
            </Button>
          )}
          <Button
            variant="ghost"
            className="h-9 gap-1.5 px-3"
            onClick={() => {
              setKey(null);
              setState(null);
              setRun(null);
              void refreshList();
            }}
          >
            <ArrowLeft className="size-4" /> Черновики
          </Button>
        </div>
      </div>

      {!state && (
        <div className="flex flex-col gap-3">
          {drafts.length > 0 && (
            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Незавершённые настройки</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                <div className="flex flex-col gap-1.5">
                  {drafts.map((d) => {
                    const done = meta ? meta.steps.filter((s) => d.steps[s.id]?.status === "done").length : 0;
                    return (
                      <div key={d.key} className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 px-3 py-2">
                        <span className="font-mono text-sm text-zinc-200">{d.key}</span>
                        {d.name && <span className="text-xs text-zinc-400">{d.name}</span>}
                        <Badge variant="outline" className="h-5 border-zinc-800 px-1.5 font-mono text-[10px] text-zinc-500">
                          {done}/{meta?.steps.length ?? 13} шагов
                        </Badge>
                        <div className="ml-auto flex items-center gap-1">
                          <Button size="sm" className="h-8" onClick={() => setKey(d.key)}>
                            Продолжить
                          </Button>
                          <Button size="sm" variant="ghost" className="h-8 px-2 text-zinc-500" onClick={() => void removeDraft(d.key)}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
          {drafts.length === 0 && (
            <p className="rounded-lg border border-dashed border-zinc-700 px-4 py-6 text-center text-sm text-zinc-500">
              Нет незавершённых настроек — начните новую.
            </p>
          )}
          <div>
            <Button className="h-11 gap-1.5 sm:h-9" onClick={() => setSheetOpen(true)} disabled={!meta}>
              <Plus className="size-4" /> Добавить колонку
            </Button>
          </div>
        </div>
      )}

      {state && meta && currentDef && (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2">
            <div className="mb-2 border-b border-zinc-800 pb-2">
              <div className="font-mono text-sm text-zinc-200">{state.key}</div>
              {state.name && <div className="text-xs text-zinc-500">{state.name}</div>}
              {state.platform && <div className="font-mono text-[10px] text-zinc-600">платформа: {state.platform}</div>}
              <div className="mt-1 font-mono text-[10px] text-zinc-600">
                черновик от {new Date(state.createdAt).toLocaleDateString("ru-RU")}
              </div>
            </div>
            <WizardStepper steps={meta.steps} statuses={state.steps} current={state.current} />
            <div className="mt-2 border-t border-zinc-800 pt-2">
              <Button
                variant="outline"
                size="sm"
                className="h-11 w-full justify-center gap-1.5 px-3 text-zinc-400 sm:h-8"
                onClick={() => void classify()}
                disabled={classifying || run?.running}
              >
                {classifying ? <Loader2 className="size-3.5 animate-spin" /> : <Radar className="size-3.5" />}
                Определить состояние
              </Button>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {allDone && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-900 bg-emerald-950/30 px-4 py-3">
                <CheckCircle2 className="size-5 text-emerald-400" />
                <div className="text-sm text-emerald-200">Колонка настроена: все шаги выполнены.</div>
                {state.registeredId && (
                  <Button asChild size="sm" className="ml-auto h-8">
                    <Link href={`/stations/${state.registeredId}`}>
                      Открыть карточку <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                )}
              </div>
            )}
            <StepPanel state={state} step={currentDef} run={run} onRun={doRun} onConfirm={(s) => void confirmStep(s)} onSkip={(s) => void skipStep(s)} />
            {state.log.length > 0 && (
              <details className="rounded-xl border border-zinc-800 bg-zinc-950/40">
                <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-2.5 text-xs font-medium tracking-wide text-zinc-400 uppercase">
                  Журнал
                  <span className="font-mono text-[10px] normal-case text-zinc-600">{state.log.length}</span>
                </summary>
                <div className="border-t border-zinc-800 px-4 py-2">
                  <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto font-mono text-[11px]">
                    {state.log.slice(-60).map((l, i) => (
                      <div key={i} className={cn("flex gap-2", l.level === "err" ? "text-amber-400" : l.level === "ok" ? "text-emerald-400" : "text-zinc-500")}>
                        <span className="shrink-0 text-zinc-700">{timeStr(l.ts)}</span>
                        <span className="min-w-0 break-words">{l.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </details>
            )}
          </div>
        </div>
      )}

      {meta && (
        <AddStationSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          steps={meta.steps}
          meta={{ subnet: meta.subnet }}
          onCreated={(k) => {
            setKey(k);
            void refreshList();
          }}
        />
      )}
    </div>
  );
}
