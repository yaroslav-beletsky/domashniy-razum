"use client";

// ADB-консоль на странице колонки по UX-спеке (docs/panel-logs-and-adb-ux.md, раздел 2):
// шапка со статусом (online/offline/applying) и контекстом пользователя, быстрые чипы,
// вывод карточками выполненных команд (stdout/stderr раздельно, сворачивание простыней),
// история (Popover на десктопе / Drawer на мобильном, ↑/↓ в инпуте), ловушки интерактивных
// команд (голый top/ping/tail -f → подсказка с безопасной заменой), аккуратный reboot
// с подтверждением и ожиданием возврата колонки, кнопка Стоп (обрывает adb на сервере).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Eraser,
  History,
  Loader2,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMediaQuery } from "@/lib/useMediaQuery";

interface ExecResult {
  id: number;
  kind: "cmd" | "reboot-wait" | "reboot-done";
  cmd: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  ms: number;
  ts: number;
}

const QUICK: Array<{ label: string; cmd: string }> = [
  { label: "id", cmd: "id" },
  { label: "getprop", cmd: "getprop" },
  { label: "df", cmd: "df -h 2>/dev/null || df" },
  // голый top в неинтерактивном adb shell течёт бесконечно — берём один снимок
  { label: "top", cmd: "top -b -n 1 2>/dev/null | head -n 35 || top -n 1 2>/dev/null | head -n 35" },
  { label: "ls /data/opt/quasar-bridge", cmd: "ls -la /data/opt/quasar-bridge" },
];

const HISTORY_KEY = (id: string) => `station-llm:adb-history:${id}`;
const HISTORY_MAX = 30;
const COLLAPSE_AFTER = 40; // строк в выводе, после которых сворачиваем
const COLLAPSE_SHOW = 25;
const RESULTS_MAX = 40;

function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString("ru-RU", { hour12: false });
}

/** Интерактивная ловушка в введённой команде → безопасная замена (спека §2.4). */
function trapHint(cmd: string): { text: string; fix: string; apply: string } | null {
  const c = cmd.trim();
  if (/^top\s*$/.test(c)) return { text: "голый top в adb shell висит до таймаута", fix: "top -n 1 | head -n 35", apply: QUICK[3].cmd };
  if (/^ping\s+[^-\s]/.test(c) && !/\s-c\s/.test(c)) {
    const host = c.split(/\s+/)[1] ?? "8.8.8.8";
    return { text: "ping без -c крутится бесконечно", fix: `ping -c 4 ${host}`, apply: `ping -c 4 ${host}` };
  }
  if (/^tail\s+.*-f/.test(c)) return { text: "tail -f не остановится сам — читайте лог во вкладке «Лог»", fix: "tail -n 50 …", apply: c.replace(/\s+-f\b/, " -n 50") };
  if (/^(sh|su)\s*$/.test(c)) return { text: "интерактивная shell-сессия здесь не поддерживается — одна команда за раз", fix: "команда аргументами", apply: "" };
  return null;
}

/** Вывод с автосворачиванием простыней (getprop, top) — спека §2.3. */
function OutputBlock({ text, tone = "stdout" }: { text: string; tone?: "stdout" | "stderr" }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const big = lines.length > COLLAPSE_AFTER;
  const shown = !expanded && big ? lines.slice(0, COLLAPSE_SHOW) : lines;
  return (
    <>
      <pre
        className={cn(
          "overflow-x-auto font-mono text-[11px] leading-5 whitespace-pre",
          tone === "stderr" ? "border-l-2 border-amber-500/60 bg-amber-950/20 py-1 pl-2 text-amber-300" : "text-zinc-200",
        )}
      >
        {shown.join("\n")}
      </pre>
      {big && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 font-mono text-[10px] text-zinc-500 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-300"
        >
          {expanded ? "свернуть" : `развернуть ещё ${lines.length - COLLAPSE_SHOW} строк (${Math.round(text.length / 1024)} КБ)`}
        </button>
      )}
    </>
  );
}

export function AdbConsole({
  stationId,
  device,
  offline,
  stationName,
  applying,
}: {
  stationId: string;
  device: string;
  offline?: boolean;
  stationName?: string;
  /** Панель сейчас применяет настройки на колонке — команды временно приглушены. */
  applying?: boolean;
}) {
  const sm = useMediaQuery("(min-width: 640px)", true);
  const [status, setStatus] = useState<{ connected: boolean; state: string } | null>(null);
  const [who, setWho] = useState<string | null>(null); // «uid=0(root) …», кеш после первого id
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [cmd, setCmd] = useState("");
  const [busy, setBusy] = useState(false);
  const [runSec, setRunSec] = useState(0);
  const [results, setResults] = useState<ExecResult[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [histPos, setHistPos] = useState(-1);
  const [histOpen, setHistOpen] = useState(false);
  const [confirmReboot, setConfirmReboot] = useState(false);
  const outRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const rid = useRef(0);
  const rebootPoll = useRef<ReturnType<typeof setInterval> | null>(null);

  // история из localStorage (по колонке)
  useEffect(() => {
    try {
      const j = JSON.parse(localStorage.getItem(HISTORY_KEY(stationId)) ?? "[]") as unknown;
      if (Array.isArray(j)) setHistory(j.filter((x): x is string => typeof x === "string").slice(0, HISTORY_MAX));
    } catch {
      /* ignore */
    }
  }, [stationId]);

  const remember = useCallback(
    (c: string) => {
      setHistory((prev) => {
        const next = [c, ...prev.filter((x) => x !== c)].slice(0, HISTORY_MAX);
        try {
          localStorage.setItem(HISTORY_KEY(stationId), JSON.stringify(next));
        } catch {
          /* private mode и т.п. */
        }
        return next;
      });
      setHistPos(-1);
    },
    [stationId],
  );

  const push = useCallback((r: ExecResult) => {
    setResults((p) => [...p, r].slice(-RESULTS_MAX));
  }, []);

  const checkStatus = useCallback(() => {
    const t0 = Date.now();
    return fetch(`/api/stations/${stationId}/adb/status`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          setStatus({ connected: Boolean(j.connected), state: String(j.state ?? "?") });
          setPingMs(Date.now() - t0);
        }
        return j as { ok?: boolean; connected?: boolean; state?: string };
      })
      .catch(() => undefined);
  }, [stationId]);

  // статус связи: сразу + опрос каждые 15 с
  useEffect(() => {
    checkStatus();
    const t = setInterval(checkStatus, 15000);
    return () => clearInterval(t);
  }, [checkStatus]);

  // автоскролл вывода к новому запуску
  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [results]);

  // тикер длительности текущей команды
  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    setRunSec(0);
    const t = setInterval(() => setRunSec(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(t);
  }, [busy]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (rebootPoll.current) clearInterval(rebootPoll.current);
    },
    [],
  );

  const connect = async () => {
    setConnecting(true);
    try {
      const r = await fetch(`/api/stations/${stationId}/adb/connect`, { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; connected?: boolean; state?: string };
      if (j.ok) setStatus({ connected: Boolean(j.connected), state: String(j.state ?? "?") });
    } finally {
      setConnecting(false);
    }
  };

  const post = (c: string, confirm: boolean, signal: AbortSignal) =>
    fetch(`/api/stations/${stationId}/adb/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ command: c, confirm }),
    }).then(async (r) => ({ status: r.status, j: (await r.json().catch(() => ({}))) as Record<string, unknown> }));

  const startRebootWatch = useCallback(() => {
    if (rebootPoll.current) clearInterval(rebootPoll.current);
    const t0 = Date.now();
    const upd = (extra: Partial<ExecResult>) =>
      setResults((p) => p.map((r) => (r.kind === "reboot-wait" ? { ...r, ...extra } : r)));
    rebootPoll.current = setInterval(() => {
      checkStatus().then((j) => {
        const sec = Math.round((Date.now() - t0) / 1000);
        if (j?.connected) {
          if (rebootPoll.current) clearInterval(rebootPoll.current);
          upd({ kind: "reboot-done", ok: true, stdout: `✓ колонка снова на связи (через ${sec} с)` });
          setStatus({ connected: true, state: "device" });
        } else if (Date.now() - t0 > 180000) {
          if (rebootPoll.current) clearInterval(rebootPoll.current);
          upd({ kind: "reboot-done", ok: false, error: "колонка не вернулась в сеть за 3 минуты — проверьте питание" });
        } else {
          upd({ stdout: `⏻ команда перезагрузки отправлена · ждём возвращения колонки в сеть… (${sec} с)` });
        }
      });
    }, 3000);
  }, [checkStatus]);

  const run = async (raw: string, opts?: { preconfirm?: boolean }) => {
    const c = raw.trim();
    if (!c || busy) return;
    setConfirmReboot(false);
    setBusy(true);
    remember(c);
    const ac = new AbortController();
    abortRef.current = ac;
    const id = ++rid.current;
    const ts = Date.now();
    if (c !== "reboot") push({ id, kind: "cmd", cmd: c, ok: true, stdout: "", stderr: "", ms: 0, ts });
    try {
      const { status, j } = await post(c, Boolean(opts?.preconfirm), ac.signal);
      if (ac.signal.aborted) {
        setResults((p) => p.filter((r) => r.id !== id));
        push({ id, kind: "cmd", cmd: c, ok: false, stdout: "", stderr: "", error: "прервано вручную", ms: Date.now() - ts, ts });
        return;
      }
      if (status === 428) {
        // опасная команда — открываем подтверждение, в ленту ничего не пишем
        setResults((p) => p.filter((r) => r.id !== id));
        if (c === "reboot" || /\breboot\b/.test(c)) setConfirmReboot(true);
        else {
          push({ id, kind: "cmd", cmd: c, ok: false, stdout: "", stderr: "", error: String(j.error ?? "требуется подтверждение"), ms: 0, ts });
        }
        return;
      }
      if (c === "reboot") {
        // связь штатно рвётся — не пугаем ошибкой, ждём возвращения (спека §2.5)
        setStatus({ connected: false, state: "rebooting" });
        push({
          id,
          kind: "reboot-wait",
          cmd: c,
          ok: true,
          stdout: "⏻ команда перезагрузки отправлена · ждём возвращения колонки в сеть… (0 с)",
          stderr: "",
          ms: Number(j.ms ?? 0),
          ts,
        });
        startRebootWatch();
        return;
      }
      const res: ExecResult = {
        id,
        kind: "cmd",
        cmd: c,
        ok: Boolean(j.ok),
        stdout: String(j.stdout ?? ""),
        stderr: String(j.stderr ?? ""),
        error: j.ok ? undefined : String(j.error ?? `ошибка ${status}`),
        ms: Number(j.ms ?? 0),
        ts,
      };
      if (res.ok && c === "id" && res.stdout.trim()) setWho(res.stdout.trim().split(" ")[0]); // uid=0(root)
      setResults((p) => p.map((r) => (r.id === id ? res : r)));
    } catch (e) {
      if (ac.signal.aborted) {
        setResults((p) => p.map((r) => (r.id === id ? { ...r, ok: false, error: "прервано вручную", ms: Date.now() - ts } : r)));
      } else {
        setResults((p) => p.map((r) => (r.id === id ? { ...r, ok: false, error: e instanceof Error ? e.message : "сеть", ms: Date.now() - ts } : r)));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      setCmd("");
      if (c !== "reboot") checkStatus();
    }
  };

  const stop = () => abortRef.current?.abort();

  // история стрелками ↑/↓ (как в терминале); черновик хранится на нулевой позиции
  const draft = useRef("");
  const onHistoryKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (!history.length) return;
    e.preventDefault();
    if (e.key === "ArrowUp") {
      const next = Math.min(histPos + 1, history.length - 1);
      if (next === 0) draft.current = cmd;
      setHistPos(next);
      setCmd(history[next]);
    } else {
      const next = histPos - 1;
      setHistPos(next);
      setCmd(next === -1 ? draft.current : history[next]);
    }
  };

  const dot = applying ? "bg-amber-400 animate-pulse" : busy || connecting ? "bg-amber-400 animate-pulse" : status?.connected ? "bg-emerald-400" : "bg-red-400";
  const statusText = applying
    ? "идёт применение настроек…"
    : busy || connecting
      ? "занято"
      : status === null
        ? "…"
        : status.connected
          ? `online · ${device}`
          : offline
            ? `offline · ${device} нет ответа`
            : `${device} · нет ответа`;

  const hint = trapHint(cmd);
  const HistoryBody = (
    <div className="flex flex-col">
      {history.length === 0 && <p className="px-1 py-3 font-mono text-[11px] text-zinc-600">история пуста — выполненные команды появятся здесь</p>}
      {history.map((h, i) => (
        <div key={`${h}@${i}`} className="flex items-center gap-1 border-b border-zinc-900 last:border-b-0">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setCmd(h);
              setHistOpen(false);
            }}
            title="подставить в поле ввода"
            className="min-h-11 min-w-0 flex-1 truncate px-1 text-left font-mono text-[11px] text-zinc-300 transition-colors hover:bg-zinc-900 sm:min-h-8"
          >
            <span className="mr-1.5 text-zinc-600">{history.length - i}.</span>
            {h}
          </button>
          <button
            type="button"
            disabled={busy}
            aria-label={`выполнить: ${h}`}
            onClick={() => {
              setHistOpen(false);
              void run(h);
            }}
            className="flex size-11 shrink-0 items-center justify-center text-zinc-500 transition-colors hover:text-emerald-400 sm:size-8"
          >
            <Play className="size-3.5" />
          </button>
        </div>
      ))}
      {history.length > 0 && (
        <button
          type="button"
          onClick={() => {
            setHistory([]);
            try {
              localStorage.removeItem(HISTORY_KEY(stationId));
            } catch {
              /* ignore */
            }
          }}
          className="mt-2 flex min-h-11 items-center justify-center gap-1.5 font-mono text-[11px] text-zinc-500 transition-colors hover:text-zinc-300 sm:min-h-8"
        >
          <Trash2 className="size-3.5" /> очистить историю
        </button>
      )}
    </div>
  );

  return (
    <section aria-label="ADB-консоль" className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 sm:p-4">
      {/* шапка подключения: статус, адрес, пинг, whoami, действия */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-zinc-400 uppercase">
          <Terminal className="size-3.5" /> ADB
        </h2>
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-zinc-500">
          <span className={cn("inline-block size-1.5 shrink-0 rounded-full", dot)} aria-hidden />
          <span className="truncate">{statusText}</span>
          {status?.connected && pingMs !== null && <span className="shrink-0 text-zinc-600">{pingMs} мс</span>}
          {status?.connected && who && <span className="shrink-0 truncate text-zinc-600">· {who}</span>}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 gap-1.5 font-mono text-[11px] sm:h-8"
            onClick={connect}
            disabled={connecting || busy}
            title="adb connect (принудительно)"
          >
            {connecting ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            <span className="hidden sm:inline">переподключить</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 gap-1.5 font-mono text-[11px] text-zinc-400 sm:h-8"
            onClick={() => setResults([])}
            disabled={busy || results.length === 0}
            title="Очистить вывод"
          >
            <Eraser className="size-3.5" />
            <span className="hidden sm:inline">очистить</span>
          </Button>
        </div>
      </div>

      {/* быстрые чипы: на мобильном — свайп-ряд, reboot отделён и вне свайпа */}
      <div className="flex items-center gap-1.5">
        <div role="group" aria-label="Быстрые команды" className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {QUICK.map((q) => (
            <Button
              key={q.label}
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || applying}
              className="h-10 shrink-0 gap-1.5 px-3 font-mono text-[11px] sm:h-7"
              onClick={() => void run(q.cmd)}
              title={q.cmd}
            >
              <Terminal className="size-3" />
              {q.label}
            </Button>
          ))}
        </div>
        <span className="mx-0.5 h-6 w-px shrink-0 bg-zinc-800" aria-hidden />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || applying}
          className="h-10 shrink-0 gap-1.5 border-red-900/60 px-3 font-mono text-[11px] text-red-400 hover:bg-red-950/40 hover:text-red-300 sm:h-7"
          onClick={() => setConfirmReboot(true)}
          title="reboot — с подтверждением"
        >
          <Power className="size-3" />
          reboot
        </Button>
      </div>

      {/* подтверждение reboot: Dialog на десктопе / Drawer снизу на телефоне */}
      {sm ? (
        <Dialog open={confirmReboot} onOpenChange={setConfirmReboot}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-red-400">
                <AlertTriangle className="size-4" /> Перезагрузить колонку{stationName ? ` «${stationName}»` : ""}?
              </DialogTitle>
              <DialogDescription>
                Команда <code className="font-mono">reboot</code> немедленно прервёт воспроизведение и перезапустит устройство. Колонка пропадёт из сети примерно на
                45–60 секунд.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="ghost"
                className="h-11 sm:h-9"
                onClick={() => setConfirmReboot(false)}
                // фокус по умолчанию — на «Отмена»
                ref={(b) => b?.focus()}
              >
                Отмена
              </Button>
              <Button type="button" className="h-11 gap-1.5 bg-red-600 hover:bg-red-500 sm:h-9" onClick={() => void run("reboot", { preconfirm: true })} disabled={busy}>
                <Power className="size-3.5" /> Перезагрузить колонку
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : (
        <Drawer open={confirmReboot} onOpenChange={setConfirmReboot}>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle className="flex items-center gap-2 text-red-400">
                <AlertTriangle className="size-4" /> Перезагрузить колонку{stationName ? ` «${stationName}»` : ""}?
              </DrawerTitle>
              <DrawerDescription>
                Команда <code className="font-mono">reboot</code> немедленно прервёт воспроизведение. Колонка пропадёт из сети примерно на 45–60 секунд.
              </DrawerDescription>
            </DrawerHeader>
            <div className="flex gap-2 px-4 pb-6">
              <Button type="button" variant="ghost" className="h-11 flex-1" onClick={() => setConfirmReboot(false)}>
                Отмена
              </Button>
              <Button type="button" className="h-11 flex-1 gap-1.5 bg-red-600 hover:bg-red-500" onClick={() => void run("reboot", { preconfirm: true })} disabled={busy}>
                <Power className="size-3.5" /> Перезагрузить
              </Button>
            </div>
          </DrawerContent>
        </Drawer>
      )}

      {/* ввод: $ + инпут + история + пуск/стоп */}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void run(cmd);
        }}
      >
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 font-mono text-xs text-zinc-600">$</span>
          <input
            value={cmd}
            onChange={(e) => {
              setCmd(e.target.value);
              if (histPos !== -1) setHistPos(-1);
            }}
            onKeyDown={onHistoryKey}
            placeholder="shell-команда…"
            aria-label="Команда adb shell"
            type="text"
            inputMode="text"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={400}
            className="h-11 w-full rounded-md border border-zinc-800 bg-zinc-950 py-2.5 pr-3 pl-7 font-mono text-base text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none sm:h-9 sm:py-1.5 sm:text-xs"
          />
        </div>

        {sm ? (
          <Popover open={histOpen} onOpenChange={setHistOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="icon" aria-label="История команд" className="size-9 shrink-0 text-zinc-400">
                <History className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-2">
              {HistoryBody}
            </PopoverContent>
          </Popover>
        ) : (
          <Drawer open={histOpen} onOpenChange={setHistOpen}>
            <DrawerTrigger asChild>
              <Button type="button" variant="outline" size="icon" aria-label="История команд" className="size-11 shrink-0 text-zinc-400">
                <History className="size-4" />
              </Button>
            </DrawerTrigger>
            <DrawerContent className="px-4 pb-6">
              <DrawerHeader className="px-0">
                <DrawerTitle className="text-sm">История команд</DrawerTitle>
              </DrawerHeader>
              {HistoryBody}
            </DrawerContent>
          </Drawer>
        )}

        {busy ? (
          <Button type="button" onClick={stop} className="h-11 gap-1.5 bg-amber-600 px-4 hover:bg-amber-500 sm:h-9" aria-label="Остановить команду">
            <Square className="size-3.5" />
            <span className="hidden font-mono text-[11px] sm:inline">стоп ({runSec} с)</span>
          </Button>
        ) : (
          <Button type="submit" disabled={!cmd.trim() || applying} className="h-11 gap-1.5 px-4 sm:h-9" aria-label="Выполнить команду">
            <Send className="size-3.5" />
            <span className="hidden sm:inline">Пуск</span>
          </Button>
        )}
      </form>

      {/* ловушки интерактивных команд */}
      {hint && !busy && (
        <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-900/50 bg-amber-950/20 px-3 py-2 font-mono text-[11px] text-amber-300/90">
          <AlertTriangle className="size-3.5 shrink-0" />
          {hint.text}.
          {hint.apply && (
            <button
              type="button"
              className="rounded border border-amber-800 px-1.5 py-0.5 text-amber-200 transition-colors hover:bg-amber-950/60"
              onClick={() => setCmd(hint.apply)}
            >
              подставить: {hint.fix}
            </button>
          )}
        </p>
      )}
      {applying && (
        <p role="status" className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 font-mono text-[11px] text-zinc-400">
          подождите ~10 с: панель сейчас перезапускает мост на колонке — выполнение произвольных команд временно заблокировано
        </p>
      )}

      {/* поток вывода: карточки выполненных команд */}
      <div
        ref={outRef}
        aria-live="polite"
        aria-label="Вывод команд"
        className="max-h-[48svh] min-h-52 overflow-y-auto rounded-md border border-zinc-800 bg-black/40 p-2.5"
      >
        {results.length === 0 ? (
          <p className="py-6 text-center font-mono text-[11px] text-zinc-600">выполните команду — вывод появится здесь</p>
        ) : (
          results.map((r) => (
            <div key={r.id} className="border-b border-zinc-900 py-2 last:border-b-0">
              <p className="flex flex-wrap items-center gap-x-2 font-mono text-[11px]">
                <span className="text-zinc-600">{timeStr(r.ts)}</span>
                <span className={cn("min-w-0 break-all", r.ok ? "text-emerald-400" : "text-red-400")}>$ {r.cmd}</span>
                <span className="text-zinc-700">
                  {r.kind === "reboot-wait" ? "ждём…" : r.ok ? "exit 0" : "ошибка"}
                  {r.ms ? ` · ${r.ms} мс` : ""}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(r.stdout || r.stderr || r.error || "").catch(() => {})}
                    className="rounded p-1 text-zinc-600 transition-colors hover:text-zinc-300"
                    aria-label="Скопировать вывод"
                    title="скопировать вывод"
                  >
                    <Copy className="size-3" />
                  </button>
                  {r.kind === "cmd" && (
                    <button
                      type="button"
                      onClick={() => void run(r.cmd)}
                      disabled={busy}
                      className="rounded p-1 text-zinc-600 transition-colors hover:text-zinc-300 disabled:opacity-40"
                      aria-label="Повторить команду"
                      title="повторить"
                    >
                      <RotateCcw className="size-3" />
                    </button>
                  )}
                </span>
              </p>
              {r.kind === "reboot-wait" && (
                <p className="mt-1 flex items-center gap-2 font-mono text-[11px] text-amber-300">
                  <Loader2 className="size-3 animate-spin" />
                  {r.stdout}
                </p>
              )}
              {r.kind === "reboot-done" && (
                <p className={cn("mt-1 flex items-center gap-1.5 font-mono text-[11px]", r.ok ? "text-emerald-400" : "text-red-400")}>
                  {r.ok ? <Check className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
                  {r.ok ? r.stdout : r.error}
                </p>
              )}
              {r.kind === "cmd" && r.stdout.trim() && (
                <div className="mt-1">
                  <OutputBlock text={r.stdout} />
                </div>
              )}
              {r.kind === "cmd" && r.stderr.trim() && (
                <div className="mt-1">
                  <OutputBlock text={r.stderr} tone="stderr" />
                </div>
              )}
              {r.kind === "cmd" && !r.ok && r.error && <p className="mt-1 font-mono text-[11px] text-red-400">{r.error}</p>}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
