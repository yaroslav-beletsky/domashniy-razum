"use client";

// Общие живые логи (SSE): тот же единый парсер, что и на странице колонки
// (lib/logParser): сырые JSON-строки показываются человекочитаемыми событиями,
// тап раскрывает pretty-JSON, есть пауза, debug-тоггл и автоскролл.
// Переехали со старой страницы «Логи» — вкладка «Диагностика» на странице агента.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Pause, Play, ScrollText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { KIND_LABEL, parseLogLine, prettyRaw, type LogLevel, type ParsedLogEvent } from "@/lib/logParser";

const SOURCES = [
  { id: "", label: "— не выбран —" },
  { id: "belch-voice", label: "belch-voice (STT/TTS)" },
  { id: "quasar-bridge", label: "quasar-bridge (мост)" },
  { id: "adb", label: "adb · tail -f" },
  { id: "panel", label: "panel" },
] as const;

const LEVEL_STYLE: Record<LogLevel, string> = {
  info: "text-zinc-300",
  warn: "text-amber-300",
  error: "text-red-300",
  debug: "text-zinc-600",
};

function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString("ru-RU", { hour12: false });
}

export function LogsViewer() {
  const [source, setSource] = useState<string>("");
  const [events, setEvents] = useState<ParsedLogEvent[]>([]);
  const [status, setStatus] = useState<{ online: boolean; detail?: string } | null>(null);
  const [paused, setPaused] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);
  const pausedBuf = useRef<ParsedLogEvent[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // SSE с автореконнектом: EventSource сам переподключается; на смену источника — пересоздаём.
  useEffect(() => {
    setEvents([]);
    setStatus(null);
    setOpenKey(null);
    pausedBuf.current = [];
    if (!source) return;

    const es = new EventSource(`/api/logs/stream?source=${encodeURIComponent(source)}`);

    es.onmessage = (ev) => {
      let msg: { type?: string; ts?: number; level?: LogLevel; text?: string; online?: boolean; detail?: string; seq?: number };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "heartbeat") return;
      if (msg.type === "status") {
        setStatus({ online: Boolean(msg.online), detail: msg.detail });
        return;
      }
      if (msg.type === "offline" || msg.type === "note" || msg.type === "line") {
        const level: LogLevel = msg.type === "line" ? (msg.level ?? "info") : msg.type === "offline" ? "warn" : "debug";
        const fe = parseLogLine(msg.text ?? msg.detail ?? "", msg.ts ?? Date.now(), level, msg.seq ?? ++seqRef.current);
        if (pausedRef.current) {
          pausedBuf.current.push(fe);
          if (pausedBuf.current.length > 500) pausedBuf.current.shift();
        } else {
          setEvents((prev) => [...prev, fe].slice(-500));
        }
      }
    };
    return () => es.close();
  }, [source]);

  // пауза: копим в буфер, на продолжение — сливаем
  useEffect(() => {
    if (!paused && pausedBuf.current.length) {
      setEvents((prev) => [...prev, ...pausedBuf.current].slice(-500));
      pausedBuf.current = [];
    }
  }, [paused]);

  useEffect(() => {
    if (autoscroll && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [events, autoscroll]);

  const toggle = useCallback((setter: (v: boolean) => void, v: boolean) => setter(!v), []);

  const visible = (showDebug ? events : events.filter((e) => e.level !== "debug")).slice(-300);
  const hidden = events.length - visible.length;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <Card>
        <CardHeader className="px-4 py-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">
            <ScrollText className="size-3.5" /> Live-логи (SSE)
            <div className="ml-auto flex items-center gap-2">
              <Badge
                variant="outline"
                className={cn(
                  "h-6 gap-1.5 font-mono text-[11px] font-normal sm:h-5",
                  status === null ? "" : status.online ? "border-emerald-900 text-emerald-400" : "border-red-900 text-red-400",
                )}
              >
                <span className={cn("inline-block size-1.5 rounded-full", status?.online ? "bg-emerald-400" : status ? "bg-red-400" : "bg-zinc-600")} />
                {status === null ? (source ? "…" : "offline") : status.online ? "online" : "offline"}
              </Badge>
              <Badge variant="outline" className="h-6 font-mono text-[11px] font-normal text-zinc-400 sm:h-5">
                {events.length} строк
              </Badge>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label htmlFor="log-source" className="font-mono text-[11px] text-zinc-500">
              источник:
            </label>
            <select
              id="log-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="h-11 min-w-44 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 font-mono text-xs text-zinc-300 sm:h-8 sm:flex-none"
            >
              {SOURCES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <label className="flex min-h-11 cursor-pointer items-center gap-1.5 font-mono text-[11px] text-zinc-500 sm:min-h-0">
              <input type="checkbox" checked={showDebug} onChange={(e) => toggle(setShowDebug, e.target.checked)} className="size-4 accent-zinc-500 sm:size-3" />
              debug
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-1.5 font-mono text-[11px] text-zinc-500 sm:min-h-0">
              <input type="checkbox" checked={autoscroll} onChange={(e) => toggle(setAutoscroll, e.target.checked)} className="size-4 accent-zinc-500 sm:size-3" />
              автоскролл
            </label>
            <Button size="sm" variant="outline" className="h-11 gap-1.5 px-3 font-mono text-xs sm:h-7 sm:px-2" onClick={() => setPaused((p) => !p)}>
              {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
              {paused ? "продолжить" : "пауза"}
            </Button>
          </div>
          {status?.detail && <div className="mb-2 font-mono text-[10px] text-zinc-600">{status.detail}</div>}
          <div
            ref={boxRef}
            className="h-[calc(100svh-19rem)] min-h-64 overflow-y-auto rounded border border-zinc-800 bg-zinc-950/60 p-2 md:h-[calc(100svh-15rem)]"
          >
            {!source && <div className="font-mono text-xs text-zinc-600">выберите источник — без него поток не стартует</div>}
            {source && visible.length === 0 && (
              <div className="font-mono text-xs text-zinc-600">
                пусто — ждём строки (автореконнект активен){hidden > 0 ? ` · скрыто debug: ${hidden}` : ""}
              </div>
            )}
            {visible.map((e, i) => {
              const open = openKey === `${e.key}@${e.seq ?? i}`;
              return (
                <div key={`${e.key}@${e.seq ?? i}`} className="border-b border-zinc-900 last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setOpenKey(open ? null : `${e.key}@${e.seq ?? i}`)}
                    aria-expanded={open}
                    className="flex w-full min-h-9 items-center gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-zinc-900/60 sm:min-h-7"
                  >
                    <span className="shrink-0 font-mono text-[10px] text-zinc-600 tabular-nums">{timeStr(e.ts)}</span>
                    <span className="shrink-0 rounded border border-zinc-800 bg-zinc-900 px-1 font-mono text-[9px] text-zinc-500">{KIND_LABEL[e.kind]}</span>
                    <span className={cn("min-w-0 flex-1 break-words text-left font-mono text-[11px] leading-5", LEVEL_STYLE[e.level])}>{e.title}</span>
                    {e.metric && <span className="shrink-0 font-mono text-[10px] text-zinc-600 tabular-nums">{e.metric}</span>}
                    <ChevronRight className={cn("size-3 shrink-0 text-zinc-600 transition-transform", open && "rotate-90")} aria-hidden />
                  </button>
                  {open && (
                    <pre className="mx-1 mb-2 max-h-56 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-[10px] leading-4 break-all whitespace-pre-wrap text-zinc-400">
                      {prettyRaw(e)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-2 font-mono text-[10px] text-zinc-600">
            SSE /api/logs/stream · единый парсер lib/logParser · секреты маскируются · heartbeat 15 с · автореконнект штатный
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
