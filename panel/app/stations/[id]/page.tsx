"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, Loader2, MoreHorizontal, Pencil, RefreshCw, Trash2, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StationView } from "@/lib/stationView";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ModelPicker } from "@/components/stations/model-picker";
import { StationLog, type LocalLine } from "@/components/stations/station-log";
import { StationSvg, ringTone } from "@/components/stations/station-svg";
import { ModeBadge, StatusBadge } from "@/components/stations/status-badge";
import { pushRecent } from "@/lib/modelNames";
import { MODE_INFO, PANEL_MODES, normalizeMode, type PanelMode } from "@/lib/modes";

const MODE_ACTIVE: Record<PanelMode, string> = {
  alice: "border-sky-800 bg-sky-950/40 text-sky-100",
  hybrid: "border-violet-800 bg-violet-950/40 text-violet-100",
  llm: "border-emerald-800 bg-emerald-950/40 text-emerald-100",
};

interface Step {
  id: string;
  label: string;
  index: number;
  total: number;
}

const KINDS = [
  { v: "unknown", l: "Не знаю" },
  { v: "max", l: "Max" },
  { v: "mini", l: "Mini" },
  { v: "lite", l: "Lite" },
];

function EditDialog({
  s,
  open,
  onOpenChange,
  onSaved,
  onDeleted,
}: {
  s: StationView;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(s.nameCustom ? s.name : "");
  const [kind, setKind] = useState(s.kind);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (open) {
      setName(s.nameCustom ? s.name : "");
      setKind(s.kind);
      setErr(null);
      setConfirmDel(false);
    }
  }, [open, s.name, s.nameCustom, s.kind]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/stations/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, kind }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) return setErr(j.error ?? `ошибка ${r.status}`);
      onOpenChange(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/stations/${s.id}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) return setErr(j.error ?? `ошибка ${r.status}`);
      onOpenChange(false);
      onDeleted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Колонка</DialogTitle>
          <DialogDescription>Комната и тип влияют только на отображение в панели.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ed-name">Комната</Label>
            <Input id="ed-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Гостиная" className="h-11 sm:h-9" />
          </div>
          <div className="grid gap-1.5">
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
            <p role="alert" className="text-xs text-amber-400">
              {err}
            </p>
          )}
          <div className="flex items-center gap-2 pt-1">
            {s.extra ? (
              confirmDel ? (
                <Button type="button" variant="destructive" className="h-11 sm:h-9" disabled={busy} onClick={del}>
                  Точно удалить
                </Button>
              ) : (
                <Button type="button" variant="ghost" className="h-11 gap-1.5 text-zinc-400 sm:h-9" onClick={() => setConfirmDel(true)}>
                  <Trash2 className="size-4" /> Удалить
                </Button>
              )
            ) : (
              <span className="text-[11px] text-zinc-600">задана в ADB_DEVICES (.env)</span>
            )}
            <Button type="submit" disabled={busy} className="ml-auto h-11 sm:h-9">
              Сохранить
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function StationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [s, setS] = useState<StationView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  // операция «применяем…»
  const [op, setOp] = useState<{ mode?: string; model?: string } | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [opError, setOpError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalLine[]>([]);
  const lid = useRef(0);
  const opRef = useRef(false);

  const addLocal = useCallback((level: LocalLine["level"], text: string) => {
    setLocal((p) => [...p, { id: ++lid.current, ts: Date.now(), level, text }].slice(-100));
  }, []);

  const load = useCallback(
    async (fresh = false) => {
      try {
        const r = await fetch(`/api/stations/${id}${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
        if (r.status === 404) return setNotFound(true);
        const j = await r.json();
        if (j.ok && !opRef.current) setS(j.station);
        else if (j.ok && !s) setS(j.station);
      } catch {
        /* оставляем прошлые данные */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );

  useEffect(() => {
    load();
    const t = setInterval(() => load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    let alive = true;
    fetch("/api/models", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => alive && j.ok && setModels(j.models))
      .catch(() => {})
      .finally(() => alive && setModelsLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  // таймер операции
  useEffect(() => {
    if (!op) return;
    const t0 = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(t);
  }, [op]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const refresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  const apply = async (change: { mode?: string; model?: string }) => {
    if (opRef.current || !s) return;
    opRef.current = true;
    setOp(change);
    setOpError(null);
    setStep(null);
    const what = [change.mode && `режим → ${MODE_INFO[change.mode as PanelMode]?.label ?? change.mode}`, change.model && `модель → ${change.model}`].filter(Boolean).join(", ");
    addLocal("info", `[панель] ${what}: запускаем`);
    if (change.model) pushRecent(change.model);

    let finished = false;
    try {
      const r = await fetch(`/api/stations/${id}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      if (!r.ok || !r.body) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `ошибка ${r.status}`);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let m: { type: string; label?: string; id?: string; index?: number; total?: number; pid?: number; error?: string };
          try {
            m = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (m.type === "step") {
            setStep({ id: m.id!, label: m.label!, index: m.index!, total: m.total! });
            addLocal("info", `[панель] ${m.index}/${m.total} · ${m.label}`);
          } else if (m.type === "done") {
            finished = true;
            addLocal("info", `[панель] готово · мост healthy (PID ${m.pid})`);
            setToast(`Готово · мост healthy (PID ${m.pid})`);
          } else if (m.type === "error") {
            finished = true;
            addLocal("error", `[панель] ошибка: ${m.error}`);
            setOpError(m.error ?? "не удалось применить");
          }
        }
      }
      if (!finished) {
        // поток оборвался: сервер доделает сам — просто перечитаем состояние
        addLocal("warn", "[панель] связь с потоком прервана, проверяем состояние…");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "ошибка";
      addLocal("error", `[панель] ${msg}`);
      setOpError(msg);
    } finally {
      opRef.current = false;
      setOp(null);
      setStep(null);
      await load(true);
    }
  };

  // ---------- состояния страницы ----------
  if (notFound) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col items-start gap-3">
        <Link href="/stations" className="inline-flex h-11 items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
          <ChevronLeft className="size-4" /> Станции
        </Link>
        <p className="text-sm text-zinc-400">Такой колонки нет в панели.</p>
      </div>
    );
  }

  if (!s) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );
  }

  const offline = s.state === "offline" && !op;
  const serverBusy = s.state === "applying" && !op; // операция запущена с другой вкладки / до перезагрузки
  const busy = Boolean(op) || serverBusy;
  const shownState = busy ? "applying" : s.state;
  const shownMode = normalizeMode(op?.mode ?? s.mode ?? (offline ? s.last?.mode : undefined));
  const shownModel = op?.model ?? s.model ?? (offline ? s.last?.model : undefined);
  const disabled = offline || busy;
  const meta = [
    s.ip,
    s.firmware && `прошивка ${s.firmware}`,
    s.bridgeVersion && `мост ${s.bridgeVersion}`,
    s.pid && !offline && `PID ${s.pid}`,
  ].filter(Boolean);
  if (offline && s.last) {
    const lm = [s.last.ip, s.last.firmware && `прошивка ${s.last.firmware}`, s.last.bridgeVersion && `мост ${s.last.bridgeVersion}`].filter(Boolean);
    if (meta.length <= 1 && lm.length) meta.splice(0, meta.length, ...lm);
  }

  const pct = step ? Math.round(((step.index - 1) / step.total) * 100 + 100 / step.total / 2) : 4;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      {/* крошки */}
      <div className="flex items-center gap-1 text-sm">
        <Link href="/stations" className="inline-flex h-11 items-center gap-1 pr-2 text-zinc-400 transition-colors hover:text-zinc-100 sm:h-9">
          <ChevronLeft className="size-4" /> Станции
        </Link>
        <span className="text-zinc-700">/</span>
        <span className="min-w-0 truncate pl-1 text-zinc-200">{s.name}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Обновить" className="size-11 sm:size-9" onClick={refresh} disabled={refreshing || busy}>
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Меню" className="size-11 sm:size-9">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="min-h-11 sm:min-h-8" onSelect={() => setEditOpen(true)}>
                <Pencil className="size-4" /> Переименовать…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="min-h-11 sm:min-h-8" onSelect={() => router.push("/stations")}>
                К списку
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* герой */}
      <section className="flex items-center gap-5 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 sm:p-5">
        <StationSvg
          kind={s.kind}
          tone={ringTone(shownState, shownMode)}
          label={`${s.name}: ${shownState}`}
          className={cn("h-24 w-[4.5rem] sm:h-32 sm:w-24", offline && "opacity-65")}
        />
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="min-w-0 truncate text-xl font-medium text-zinc-50">{s.name}</h1>
            <StatusBadge state={shownState} />
            <ModeBadge mode={shownMode} muted={offline} />
          </div>
          <p className="font-mono text-[11px] leading-relaxed break-words text-zinc-500">{meta.join(" · ")}</p>
        </div>
      </section>

      {offline && (
        <div role="status" className="flex items-start gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3.5 py-3 text-sm text-zinc-400">
          <WifiOff className="mt-0.5 size-4 shrink-0 text-zinc-500" />
          <span>Не на связи — показаны последние настройки, лог в ожидании. Страница сама подхватит колонку, когда она вернётся.</span>
        </div>
      )}

      {!offline && s.state === "bridge-down" && !busy && (
        <div role="status" className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-3.5 py-3 text-sm text-amber-300/90">
          Колонка отвечает, но мост не healthy{s.error ? ` — ${s.error}` : ""}. Применение настроек перезапустит мост.
        </div>
      )}

      {/* управление */}
      <section className="grid gap-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 sm:grid-cols-2 sm:gap-x-6">
        <div className="grid gap-1.5 sm:col-span-2">
          <Label className="text-xs text-zinc-500">Режим</Label>
          <div role="radiogroup" aria-label="Режим" className="grid gap-2 sm:grid-cols-3">
            {PANEL_MODES.map((m) => {
              const active = shownMode === m;
              const pending = op?.mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={disabled}
                  onClick={() => !active && apply({ mode: m })}
                  className={cn(
                    "flex min-h-[44px] flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                    active ? MODE_ACTIVE[m] : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900",
                    disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
                    pending && "animate-pulse",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {pending && <Loader2 className="size-3 animate-spin" />}
                    {MODE_INFO[m].label}
                  </span>
                  <span className={cn("text-xs leading-snug", active ? "opacity-80" : "text-zinc-500")}>{MODE_INFO[m].hint}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid min-w-0 gap-1.5 sm:col-span-2">
          <Label className="text-xs text-zinc-500">Активная модель</Label>
          <ModelPicker
            models={models}
            value={shownModel}
            loading={modelsLoading}
            disabled={disabled || modelsLoading}
            onSelect={(m) => apply({ model: m })}
          />
        </div>

        {(busy || opError) && (
          <div className="sm:col-span-2" aria-live="polite">
            {busy && (
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-amber-300">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Loader2 className="size-3 shrink-0 animate-spin" />
                    <span className="truncate">
                      применяем…{step ? ` ${step.index}/${step.total} · ${step.label}` : serverBusy ? " операция уже идёт" : ""}
                    </span>
                  </span>
                  {op && <span className="shrink-0 tabular-nums">{elapsed} с</span>}
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                  <div className="h-full rounded-full bg-amber-400 transition-[width] duration-500" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )}
            {opError && !busy && (
              <p role="alert" className="rounded-md border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
                Не удалось применить: {opError}
              </p>
            )}
          </div>
        )}
      </section>

      <StationLog stationId={id} local={local} offline={offline} />

      {/* тост */}
      {toast && (
        <div
          role="status"
          className="fixed inset-x-3 bottom-20 z-50 mx-auto flex max-w-sm items-center gap-2 rounded-lg border border-emerald-800 bg-emerald-950/95 px-4 py-3 text-sm text-emerald-200 shadow-xl backdrop-blur md:bottom-6"
        >
          <CheckCircle2 className="size-4 shrink-0" />
          {toast}
        </div>
      )}

      <EditDialog s={s} open={editOpen} onOpenChange={setEditOpen} onSaved={() => load(true)} onDeleted={() => router.push("/stations")} />
    </div>
  );
}
