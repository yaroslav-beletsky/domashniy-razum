"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Level = "info" | "warn" | "error" | "debug";

export interface LogLine {
  seq: number;
  ts: number;
  level: Level;
  text: string;
}

/** Строки, которые добавляет сама страница (шаги операции) — смешиваются с SSE по времени. */
export interface LocalLine {
  id: number;
  ts: number;
  level: Level;
  text: string;
}

const LEVEL_STYLE: Record<Level, string> = {
  info: "text-zinc-300",
  warn: "text-amber-400",
  error: "text-red-400",
  debug: "text-zinc-600",
};

const MAX = 600;

function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString("ru-RU", { hour12: false });
}

interface Props {
  stationId: string;
  local?: LocalLine[];
  /** Колонка не на связи — лог «в ожидании», подключение остаётся (EventSource сам переподключается). */
  offline?: boolean;
}

export function StationLog({ stationId, local = [], offline }: Props) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [conn, setConn] = useState<{ online: boolean; detail?: string } | null>(null);
  const [filter, setFilter] = useState<"all" | "errors">("all");
  const [stick, setStick] = useState(true);
  const [clearedAt, setClearedAt] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    setLines([]);
    setConn(null);
    seq.current = 0;
    const es = new EventSource(
      `/api/logs/stream?source=quasar-bridge&station=${encodeURIComponent(stationId)}`,
    );
    es.onmessage = (ev) => {
      let m: { type?: string; ts?: number; level?: Level; text?: string; online?: boolean; detail?: string };
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === "heartbeat") return;
      if (m.type === "status") {
        setConn({ online: Boolean(m.online), detail: m.detail });
        return;
      }
      if (m.type === "line" || m.type === "offline" || m.type === "note") {
        const level: Level = m.type === "line" ? (m.level ?? "info") : m.type === "offline" ? "warn" : "debug";
        const text = m.text ?? m.detail ?? "";
        setLines((p) => [...p, { seq: ++seq.current, ts: m.ts ?? Date.now(), level, text }].slice(-MAX));
      }
    };
    es.onerror = () => setConn((c) => (c ? { ...c, online: false } : { online: false, detail: "переподключаемся…" }));
    return () => es.close();
  }, [stationId]);

  const all = useMemo(() => {
    const merged: Array<{ key: string; ts: number; level: Level; text: string; mine?: boolean }> = [
      ...lines.map((l) => ({ key: `s${l.seq}`, ts: l.ts, level: l.level, text: l.text })),
      ...local.map((l) => ({ key: `l${l.id}`, ts: l.ts, level: l.level, text: l.text, mine: true })),
    ];
    merged.sort((a, b) => a.ts - b.ts);
    return merged.filter((l) => l.ts >= clearedAt && l.level !== "debug" && (filter === "all" || l.level === "error" || l.level === "warn"));
  }, [lines, local, filter, clearedAt]);

  // автопрокрутка, пока пользователь «у дна»
  useEffect(() => {
    const el = boxRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [all, stick]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  const toEnd = () => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStick(true);
  };

  return (
    <section aria-label="Живой лог" className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-950/60">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Лог</h2>
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
          <span
            className={cn(
              "inline-block size-1.5 rounded-full",
              conn?.online ? "bg-emerald-400" : "bg-zinc-600",
              conn?.online && !offline && "station-pulse",
            )}
          />
          {conn === null ? "…" : conn.online ? "live" : "в ожидании"}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <div role="group" aria-label="Фильтр" className="flex rounded-md border border-zinc-800 p-0.5">
            {(["all", "errors"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={cn(
                  "h-9 rounded px-3 font-mono text-[11px] transition-colors sm:h-7 sm:px-2.5",
                  filter === f ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
                )}
              >
                {f === "all" ? "все" : "ошибки"}
              </button>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-11 px-3 font-mono text-[11px] text-zinc-400 sm:h-8"
            onClick={() => setClearedAt(Date.now())}
          >
            Очистить
          </Button>
        </div>
      </div>

      <div className="relative">
        <div
          ref={boxRef}
          onScroll={onScroll}
          className="h-[40svh] min-h-56 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5 sm:h-80"
        >
          {all.length === 0 ? (
            <p className="py-6 text-center text-zinc-600">
              {offline ? "лог в ожидании — станция не на связи" : filter === "errors" ? "ошибок нет" : "строк пока нет…"}
            </p>
          ) : (
            all.map((l) => (
              <div key={l.key} className={cn("flex gap-2 break-all", LEVEL_STYLE[l.level], l.mine && "text-sky-300")}>
                <span className="shrink-0 text-zinc-600">{timeStr(l.ts)}</span>
                <span className="min-w-0">{l.text}</span>
              </div>
            ))
          )}
        </div>
        {!stick && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={toEnd}
            className="absolute right-3 bottom-3 h-11 gap-1.5 font-mono text-[11px] shadow-lg sm:h-8"
          >
            <ArrowDown className="size-3.5" /> В конец
          </Button>
        )}
      </div>
    </section>
  );
}
