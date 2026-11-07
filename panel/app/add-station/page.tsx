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

interface WizardMeta {
  steps: WizardStepDef[];
  standUrl: string;
  targetFirmware: string;
  subnet: string;
}

interface Candidate {
  ip: string;
  adb: boolean;
  alive: boolean;
  known?: string;
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
}

const KINDS = [
  { v: "unknown", l: "Не знаю" },
  { v: "max", l: "Max" },
  { v: "mini", l: "Mini" },
  { v: "lite", l: "Lite" },
];

const MODE_LABELS: Record<string, string> = { alice: "Алиса", hybrid: "Гибрид", llm: "Только моя модель" };

function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString("ru-RU", { hour12: false });
}

// ---------- обнаружение колонок (шаг 1) ----------

function Discovery({
  meta,
  onCreated,
}: {
  meta: WizardMeta;
  onCreated: (key: string) => void;
}) {
  const [subnet, setSubnet] = useState(meta.subnet);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("5555");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("unknown");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const runScan = async () => {
    setScanning(true);
    setErr(null);
    setCandidates(null);
    setProgress("…");
    abort.current = new AbortController();
    const found: Candidate[] = [];
    const r = await postSse(
      "/api/wizard/scan",
      { subnet },
      (m) => {
        const d = m.data;
        if (d.type === "progress") setProgress(`${d.scanned}/${d.total}`);
        if (d.type === "host") found.push({ ip: String(d.ip), adb: true, alive: true, known: d.known ? String(d.known) : undefined });
        if (d.type === "done" && Array.isArray(d.candidates)) setCandidates(d.candidates as Candidate[]);
        if (d.type === "error") setErr(String(d.error));
      },
      abort.current.signal,
    );
    if (!r.ok && r.status !== 0) setErr(r.error ?? "ошибка сканирования");
    if (!candidates) setCandidates(found);
    setScanning(false);
  };

  const create = async (h: string, p: string) => {
    setBusy(true);
    setErr(null);
    try {
      const j = await api<{ key: string }>("/api/wizard/state", { method: "POST", body: { action: "create", host: h, port: Number(p) || 5555, name, kind } });
      onCreated(j.key);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "не удалось создать черновик");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="px-4 py-3">
          <CardTitle className="flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">
            <Radar className="size-3.5" /> Поиск колонок в сети
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          <p className="mb-2 text-[13px] text-zinc-400">Найду устройства в сети — колонки с открытым портом 5555 покажу первыми.</p>
          <details className="group mb-3">
            <summary className="cursor-pointer select-none text-[11px] text-zinc-600 transition-colors hover:text-zinc-400">
              Как определяется колонка
            </summary>
            <p className="mt-1 text-[11px] leading-snug text-zinc-500">
              «Похоже на колонку» — эвристика по открытым портам: MAC-адреса из контейнера недоступны.
            </p>
          </details>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="wiz-subnet">Подсеть</Label>
              <Input id="wiz-subnet" value={subnet} onChange={(e) => setSubnet(e.target.value)} className="h-11 w-36 font-mono sm:h-9" />
            </div>
            <Button onClick={runScan} disabled={scanning} className="h-11 gap-1.5 sm:h-9">
              {scanning ? <Loader2 className="size-4 animate-spin" /> : <Radar className="size-4" />}
              {scanning ? `скан ${progress}` : "Сканировать"}
            </Button>
            {scanning && (
              <Button variant="ghost" className="h-11 sm:h-9" onClick={() => abort.current?.abort()}>
                Стоп
              </Button>
            )}
          </div>

          {candidates !== null && (
            <div className="mt-3 flex flex-col gap-1.5">
              {candidates.length === 0 && <div className="font-mono text-xs text-zinc-500">ничего не найдено — колонка выключена или не в сети</div>}
              {candidates.map((c) => (
                <div key={c.ip} className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 px-3 py-2">
                  <span className="font-mono text-sm text-zinc-200">{c.ip}</span>
                  {c.adb ? (
                    <Badge variant="outline" className="h-5 gap-1 border-emerald-900 px-1.5 font-mono text-[10px] text-emerald-300">
                      :5555 открыт — похоже на колонку
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="h-5 gap-1 border-zinc-800 px-1.5 font-mono text-[10px] text-zinc-500">
                      в сети, :5555 закрыт
                    </Badge>
                  )}
                  {c.known && (
                    <Badge variant="outline" className="h-5 gap-1 border-sky-900 px-1.5 font-mono text-[10px] text-sky-300">
                      в реестре: {c.known}
                    </Badge>
                  )}
                  <Button size="sm" variant="secondary" className="ml-auto h-8" disabled={busy} onClick={() => void create(c.ip, "5555")}>
                    Выбрать
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-4 py-3">
          <CardTitle className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Или введите адрес вручную</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          <div className="grid grid-cols-[1fr_5.5rem] gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="wiz-host">IP-адрес колонки</Label>
              <Input id="wiz-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.88.80" inputMode="decimal" className="h-11 font-mono sm:h-9" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="wiz-port">Порт</Label>
              <Input id="wiz-port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" className="h-11 font-mono sm:h-9" />
            </div>
          </div>
          <div className="mt-2 grid gap-1.5">
            <Label htmlFor="wiz-name">Комната (необязательно)</Label>
            <Input id="wiz-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Гостиная" className="h-11 sm:h-9" />
          </div>
          <div className="mt-2 grid gap-1.5">
            <Label>Тип</Label>
            <div role="radiogroup" aria-label="Тип колонки" className="grid grid-cols-4 gap-1.5">
              {KINDS.map((k) => (
                <button
                  key={k.v}
                  type="button"
                  role="radio"
                  aria-checked={kind === k.v}
                  onClick={() => setKind(k.v)}
                  className={cn(
                    "h-11 rounded-md border text-xs transition-colors sm:h-9",
                    kind === k.v ? "border-zinc-500 bg-zinc-800 text-zinc-50" : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
                  )}
                >
                  {k.l}
                </button>
              ))}
            </div>
          </div>
          {err && (
            <p role="alert" className="mt-2 text-xs text-amber-400">
              {err}
            </p>
          )}
          <div className="mt-3 flex justify-end">
            <Button className="h-11 gap-1.5 sm:h-9" disabled={busy || !host.trim()} onClick={() => void create(host.trim(), port)}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Начать настройку
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
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
  const [model, setModel] = useState(state.model ?? "");
  const [agent, setAgent] = useState("");
  const [regName, setRegName] = useState(state.name ?? "");
  const [regKind, setRegKind] = useState(state.kind ?? "unknown");
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    fetch("/api/models", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j && Array.isArray(j.models)) setModels(j.models.map((m: { id?: string }) => m.id).filter(Boolean).slice(0, 200));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const running = run?.step === step.id && run.running;
  const execLabel =
    step.id === "ota"
      ? "Проверить прошивку"
      : step.id === "bridge"
        ? "Проверить/установить мост"
        : step.id === "staticip"
          ? "Показать конфигурацию"
          : step.id === "mode"
            ? "Применить режим/модель"
            : step.id === "register"
              ? "Зарегистрировать"
              : step.id === "test"
                ? "Показать лог моста"
                : "Выполнить";


  const runWithDanger = () => {
    if (step.danger && !window.confirm(`Шаг «${step.title}» меняет системную часть колонки. Откат описан в памятке шага. Продолжить?`)) return;
    onRun(step.id, step.id === "mode" ? { mode, model: model.trim() || undefined } : step.id === "register" ? { name: regName, kind: regKind, agent } : undefined);
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
            <div className="grid gap-1.5">
              <Label htmlFor="wiz-model">Модель</Label>
              <Input id="wiz-model" value={model} onChange={(e) => setModel(e.target.value)} list="wiz-model-list" placeholder="gpt-4o-mini" className="h-11 font-mono sm:h-9" />
              <datalist id="wiz-model-list">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
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
              <div role="radiogroup" aria-label="Тип колонки" className="grid grid-cols-4 gap-1.5">
                {KINDS.map((k) => (
                  <button
                    key={k.v}
                    type="button"
                    role="radio"
                    aria-checked={regKind === k.v}
                    onClick={() => setRegKind(k.v)}
                    className={cn(
                      "h-11 rounded-md border text-xs transition-colors sm:h-9",
                      regKind === k.v ? "border-zinc-500 bg-zinc-800 text-zinc-50" : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
                    )}
                  >
                    {k.l}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="wiz-agent">Агент (необязательно)</Label>
              <Input id="wiz-agent" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="dushnila" className="h-11 font-mono sm:h-9" />
            </div>
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
  const [view, setView] = useState<"list" | "new">("list");
  const abort = useRef<AbortController | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const j = await api<{ states: WizardState[] } & WizardMeta>("/api/wizard/state");
      setDrafts(j.states);
      setMeta({ steps: j.steps, standUrl: j.standUrl, targetFirmware: j.targetFirmware, subnet: j.subnet });
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
        <span className="font-mono text-[11px] text-zinc-600">целевая прошивка {meta?.targetFirmware ?? "…"}</span>
        <div className="ml-auto flex items-center gap-2">
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
              setView("list");
              void refreshList();
            }}
          >
            <ArrowLeft className="size-4" /> Черновики
          </Button>
        </div>
      </div>

      {!state && view === "list" && (
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
            <Button className="h-11 gap-1.5 sm:h-9" onClick={() => setView("new")}>
              <Plus className="size-4" /> Новая колонка
            </Button>
          </div>
        </div>
      )}

      {!state && view === "new" && meta && (
        <Discovery
          meta={meta}
          onCreated={(k) => {
            setView("list");
            setKey(k);
            void refreshList();
          }}
        />
      )}

      {state && meta && currentDef && (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2">
            <div className="mb-2 border-b border-zinc-800 pb-2">
              <div className="font-mono text-sm text-zinc-200">{state.key}</div>
              {state.name && <div className="text-xs text-zinc-500">{state.name}</div>}
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
    </div>
  );
}
