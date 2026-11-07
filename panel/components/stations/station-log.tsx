"use client";

// Живой лог колонки по UX-спеке (docs/panel-logs-and-adb-ux.md, раздел 1):
// строка = время + иконка + пилюля категории + человеческий текст + метрика;
// тап → pretty-JSON; схлопывание повторов (×N) и стектрейсов; фильтры Все/Диалог/Мост·ADB/Ошибки;
// поиск с подсветкой (по тексту и сырому JSON); пауза с буфером 500 строк; автоскролл с «↓ В конец»;
// копирование среза (текст / JSONL) и очистка с возвратом хвоста; мобильная двухстрочная вёрстка.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeftRight,
  Bug,
  Cable,
  Check,
  ChevronRight,
  CircleAlert,
  Compass,
  Copy,
  Cpu,
  Eraser,
  GitBranch,
  Info,
  Mic,
  MoreHorizontal,
  Pause,
  Play,
  Search,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  Volume2,
  Waves,
  WifiOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DIALOG_KINDS,
  highlightJson,
  KIND_LABEL,
  parseLogLine,
  prettyRaw,
  type LogKind,
  type LogLevel,
  type ParsedLogEvent,
} from "@/lib/logParser";

/** Строки, которые добавляет сама страница (шаги операции) — смешиваются с SSE по времени. */
export interface LocalLine {
  id: number;
  ts: number;
  level: LogLevel;
  text: string;
}

type Filter = "all" | "dialog" | "system" | "problems";
type SourceKey = "mix" | "bridge" | "voice" | "adb";

const SOURCES: Array<{ key: SourceKey; label: string; stream: string; withPanel: boolean }> = [
  { key: "mix", label: "Мост + Панель", stream: "quasar-bridge", withPanel: true },
  { key: "bridge", label: "Только мост (quasar-bridge)", stream: "quasar-bridge", withPanel: false },
  { key: "voice", label: "Голос (belch-voice)", stream: "belch-voice", withPanel: false },
  { key: "adb", label: "Прямой adb tail", stream: "adb", withPanel: false },
];
const sourceByKey = (k: SourceKey) => SOURCES.find((s) => s.key === k) ?? SOURCES[0];

const MAX_EVENTS = 600;
const PAUSE_BUF = 500;
const TURN_GAP_MS = 8000;
const STACK_GLUE_MS = 250;

/** Иконка и акценты по категории (спека §1.2). */
function kindVisual(kind: LogKind, json?: Record<string, unknown>): { icon: typeof Mic; iconCls: string; pillCls: string } {
  switch (kind) {
    case "stt":
      return { icon: Mic, iconCls: "text-sky-400", pillCls: "border-sky-800/70 bg-sky-950/60 text-sky-300" };
    case "route": {
      const toLlm = json?.route === "llm";
      return toLlm
        ? { icon: GitBranch, iconCls: "text-emerald-400", pillCls: "border-emerald-800/70 bg-emerald-950/60 text-emerald-300" }
        : { icon: Compass, iconCls: "text-violet-400", pillCls: "border-violet-800/70 bg-violet-950/60 text-violet-300" };
    }
    case "llm":
      return { icon: Sparkles, iconCls: "text-emerald-400", pillCls: "border-emerald-800/60 bg-emerald-950/50 text-emerald-300" };
    case "tts":
      return { icon: Volume2, iconCls: "text-teal-400", pillCls: "border-teal-800/60 bg-teal-950/50 text-teal-300" };
    case "bridge":
      return { icon: Cpu, iconCls: "text-zinc-400", pillCls: "border-zinc-800 bg-zinc-900 text-zinc-400" };
    case "system":
      return { icon: Cable, iconCls: "text-zinc-500", pillCls: "border-zinc-800 bg-zinc-900 text-zinc-500" };
    case "panel":
      return { icon: SlidersHorizontal, iconCls: "text-sky-300", pillCls: "border-sky-900 bg-sky-950/40 text-sky-300" };
    case "transport":
      return { icon: ArrowLeftRight, iconCls: "text-zinc-600", pillCls: "border-zinc-800/70 bg-zinc-900/60 text-zinc-600" };
    default:
      return { icon: Info, iconCls: "text-zinc-500", pillCls: "border-zinc-800 bg-zinc-900 text-zinc-500" };
  }
}

const LEVEL_TEXT: Record<LogLevel, string> = {
  info: "text-zinc-200",
  warn: "text-amber-200",
  error: "text-red-200",
  debug: "text-zinc-500",
};

function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString("ru-RU", { hour12: false });
}

/** Шум: debug-уровень и кадры транспорта — скрыты без тоггла «+ шум». */
const isNoise = (e: ParsedLogEvent) => e.level === "debug" || e.kind === "transport";

interface Row {
  key: string;
  firstTs: number;
  lastTs: number;
  count: number;
  level: LogLevel;
  kind: LogKind;
  event: ParsedLogEvent;
  mine?: boolean;
}

/** Подсветка совпадений поиска в тексте строки. */
function Highlight({ text, q }: { text: string; q: string }) {
  const query = q.trim().toLowerCase();
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let n = 0;
  for (;;) {
    const idx = lower.indexOf(query, i);
    if (idx < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={n++} className="rounded bg-amber-500/25 px-0.5 text-amber-200">
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    i = idx + query.length;
    if (parts.length > 60) break; // длинные JSON не подсвечиваем по кускам бесконечно
  }
  return <>{parts}</>;
}

export function StationLog({ stationId, local = [], offline }: Props) {
  const [events, setEvents] = useState<ParsedLogEvent[]>([]);
  const [conn, setConn] = useState<{ online: boolean; detail?: string; lostAt?: number } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [noise, setNoise] = useState(false);
  const [source, setSource] = useState<SourceKey>("mix");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [stick, setStick] = useState(true);
  const [clearedAt, setClearedAt] = useState(0);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<"" | "text" | "jsonl" | "one">("");
  const boxRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const pausedBuf = useRef<ParsedLogEvent[]>([]);
  const lastDecisionTs = useRef(0);
  const pendingErr = useRef<{ ev: ParsedLogEvent; at: number } | null>(null);

  useEffect(() => {
    setEvents([]);
    setConn(null);
    setOpenKey(null);
    setPendingCount(0);
    pausedBuf.current = [];
    lastDecisionTs.current = 0;
    pendingErr.current = null;

    const src = sourceByKey(source);
    const es = new EventSource(
      `/api/logs/stream?source=${src.stream}&station=${encodeURIComponent(stationId)}`,
    );
    es.onmessage = (ev) => {
      let m: {
        type?: string;
        ts?: number;
        level?: LogLevel;
        text?: string;
        online?: boolean;
        detail?: string;
        seq?: number;
        source?: string;
      };
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === "heartbeat") return;
      if (m.type === "status") {
        setConn((c) => {
          const online = Boolean(m.online);
          return { online, detail: m.detail, lostAt: online ? undefined : (c?.lostAt ?? Date.now()) };
        });
        return;
      }
      if (m.type === "line" || m.type === "offline" || m.type === "note") {
        const level: LogLevel = m.type === "line" ? (m.level ?? "info") : m.type === "offline" ? "warn" : "debug";
        const text = m.text ?? m.detail ?? "";
        const fe = parseLogLine(text, m.ts ?? Date.now(), level, m.seq);
        if (m.source) fe.source = m.source;
        const withSrc = fe;

        // склейка строк стектрейса к предыдущей ошибке (спека §1.4.2)
        const pe = pendingErr.current;
        if (withSrc.isStack && pe && Date.now() - pe.at < STACK_GLUE_MS + 4000) {
          pe.ev.json = undefined;
          pe.ev.title = lastMeaningfulLine(pe.ev.raw + "\n" + withSrc.raw);
          pe.ev.raw = `${pe.ev.raw}\n${withSrc.raw}`;
          pe.at = Date.now();
          setEvents((p) => p.slice()); // тот же объект — принудительный перерендер
          return;
        }

        // «хвост» диалога ушёл Алисе напрямую, без свежего решения маршрута — подсвечиваем (§1.3 №5)
        const jm = withSrc.json?.msg;
        if (jm === "native_route_decision") lastDecisionTs.current = withSrc.ts;
        if (jm === "native_route" && withSrc.json?.route !== "llm" && withSrc.ts - lastDecisionTs.current > 5000) {
          withSrc.level = "warn";
          withSrc.title = "Продолжение диалога ушло в Алису напрямую (мимо правил маршрутизации)";
          withSrc.key = `route|warn|${withSrc.title}`;
        }

        pendingErr.current = withSrc.level === "error" && !withSrc.isStack ? { ev: withSrc, at: Date.now() } : null;

        if (pausedRef.current) {
          if (pausedBuf.current.length >= PAUSE_BUF) pausedBuf.current.shift();
          pausedBuf.current.push(withSrc);
          setPendingCount((n) => n + 1);
        } else {
          setEvents((p) => [...p, withSrc].slice(-MAX_EVENTS));
        }
      }
    };
    es.onerror = () =>
      setConn((c) => (c ? { ...c, online: false, lostAt: c.lostAt ?? Date.now() } : { online: false, detail: "переподключаемся…", lostAt: Date.now() }));
    return () => es.close();
  }, [stationId, source]);

  const togglePause = () => {
    if (paused) {
      const buf = pausedBuf.current;
      pausedBuf.current = [];
      setPendingCount(0);
      if (buf.length) setEvents((p) => [...p, ...buf].slice(-MAX_EVENTS));
      setStick(true);
    }
    setPaused((p) => !p);
  };

  // локальные шаги панели + SSE события, общая сортировка по времени
  const merged = useMemo(() => {
    const all: ParsedLogEvent[] = [
      ...events,
      ...local.map((l) => ({
        key: `panel|${l.level}|${l.text.slice(0, 120)}|${l.id}`,
        ts: l.ts,
        level: l.level,
        kind: "panel" as LogKind,
        title: l.text,
        raw: l.text,
        seq: l.id,
      })),
    ];
    all.sort((a, b) => a.ts - b.ts);
    return all;
  }, [events, local]);

  // схлопывание подряд идущих одинаковых событий (спека §1.4.1)
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const e of merged) {
      if (e.ts < clearedAt) continue;
      if (!noise && isNoise(e)) continue;
      const prev = out[out.length - 1];
      if (prev && prev.key === e.key) {
        prev.count += 1;
        prev.lastTs = e.ts;
        prev.event = e; // раскрытие показывает последнее событие пачки
        continue;
      }
      out.push({
        key: e.key,
        firstTs: e.ts,
        lastTs: e.ts,
        count: 1,
        level: e.level,
        kind: e.kind,
        event: e,
        mine: e.kind === "panel",
      });
    }
    return out;
  }, [merged, clearedAt, noise]);

  const problems = useMemo(() => rows.filter((r) => r.level === "warn" || r.level === "error").length, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "dialog" && !DIALOG_KINDS.includes(r.kind)) return false;
      if (filter === "system" && !["bridge", "system", "panel"].includes(r.kind)) return false;
      if (filter === "problems" && r.level !== "warn" && r.level !== "error") return false;
      if (!q) return true;
      return r.event.title.toLowerCase().includes(q) || r.event.raw.toLowerCase().includes(q);
    });
  }, [rows, filter, query]);

  const hiddenCount = rows.length - visible.length;

  // автоскролл, пока пользователь «у дна»
  useEffect(() => {
    const el = boxRef.current;
    if (el && stick && !paused) el.scrollTop = el.scrollHeight;
  }, [visible, stick, paused]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 32);
  };

  const toEnd = () => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStick(true);
  };

  const flashCopied = (what: "text" | "jsonl" | "one") => {
    setCopied(what);
    setTimeout(() => setCopied(""), 1500);
  };

  const copyText = async (text: string, what: "text" | "jsonl" | "one") => {
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(what);
    } catch {
      /* clipboard недоступен */
    }
  };

  const copyVisibleText = () =>
    copyText(
      visible.map((r) => `${timeStr(r.lastTs)} [${KIND_LABEL[r.kind]}]${r.count > 1 ? ` ×${r.count}` : ""} ${r.event.title}`).join("\n"),
      "text",
    );
  const copyVisibleJsonl = () => copyText(visible.map((r) => r.event.raw).join("\n"), "jsonl");

  const FILTERS: Array<{ key: Filter; label: string }> = [
    { key: "all", label: "Все" },
    { key: "dialog", label: "Диалог" },
    { key: "system", label: "Мост/ADB" },
    { key: "problems", label: "Ошибки" },
  ];

  const away = !stick || paused;
  const showBanner = conn !== null && !conn.online;

  return (
    <section aria-label="Живой лог" className="flex flex-col overflow-x-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
      {/* шапка: статус + источник + действия */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
          <span
            className={cn(
              "inline-block size-1.5 rounded-full",
              conn?.online && !offline ? "bg-emerald-400 station-pulse" : conn === null ? "bg-zinc-600" : "bg-amber-400/80",
            )}
          />
          {conn === null ? "…" : conn.online && !offline ? "live" : "в ожидании (автореконнект…)"}
        </span>
        {/* источник (десктоп — компактный селект; на мобильном — в меню ⋯) */}
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as SourceKey)}
          aria-label="Источник лога"
          className="hidden h-8 max-w-52 rounded-md border border-zinc-800 bg-zinc-950 px-1.5 font-mono text-[11px] text-zinc-400 focus:border-zinc-600 focus:outline-none sm:block"
        >
          {SOURCES.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        {conn?.detail && <span className="hidden max-w-40 truncate font-mono text-[10px] text-zinc-600 lg:inline">{conn.detail}</span>}

        <div className="ml-auto flex items-center gap-1">
          {/* поиск: на мобильном раскрывается тапом по 🔍 */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-pressed={searchOpen}
            aria-label="Поиск"
            onClick={() => setSearchOpen((v) => !v)}
            className="size-11 text-zinc-400 sm:hidden"
          >
            <Search className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={paused}
            onClick={togglePause}
            className="h-11 gap-1.5 font-mono text-[11px] text-zinc-400 sm:h-8"
          >
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            {paused && pendingCount > 0 && <span className="text-amber-300">+{pendingCount}</span>}
            <span className="hidden sm:inline">{paused ? "продолжить" : "пауза"}</span>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Ещё действия" className="size-11 text-zinc-400 sm:size-8">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-[10px] text-zinc-500 sm:text-xs">Источник</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={source} onValueChange={(v) => setSource(v as SourceKey)}>
                {SOURCES.map((s) => (
                  <DropdownMenuRadioItem key={s.key} value={s.key} className="min-h-11 text-xs sm:min-h-8">
                    {s.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={noise} onCheckedChange={(v) => setNoise(Boolean(v))} className="min-h-11 text-xs sm:min-h-8">
                <Bug className="size-3.5" /> + шум (debug)
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="min-h-11 gap-2 text-xs sm:min-h-8" onSelect={copyVisibleText}>
                {copied === "text" ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />} Копировать видимые (текст)
              </DropdownMenuItem>
              <DropdownMenuItem className="min-h-11 gap-2 text-xs sm:min-h-8" onSelect={copyVisibleJsonl}>
                {copied === "jsonl" ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />} Копировать видимые (сырой лог / JSONL)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="min-h-11 gap-2 text-xs text-zinc-400 sm:min-h-8"
                onSelect={() => {
                  setClearedAt(Date.now());
                  setOpenKey(null);
                }}
              >
                <Eraser className="size-3.5" /> Очистить
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* поиск (мобильный — раскрывается; десктоп — сразу виден) */}
      {(searchOpen || undefined) && (
        <div className="border-b border-zinc-800 px-3 py-2 sm:hidden">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-600" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="поиск по тексту и JSON…"
              aria-label="Поиск по логу"
              className="h-11 w-full rounded-md border border-zinc-800 bg-zinc-950 pl-8 pr-8 font-mono text-[13px] text-zinc-300 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
            />
            {query && (
              <button type="button" aria-label="Сбросить поиск" onClick={() => setQuery("")} className="absolute top-1/2 right-2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300">
                ✕
              </button>
            )}
          </div>
        </div>
      )}

      {/* фильтры: чипы в 1 клик + поиск на десктопе */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <div role="group" aria-label="Фильтр по типу" className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={cn(
                "flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 font-mono text-[11px] whitespace-nowrap transition-colors sm:h-8 sm:px-2.5",
                filter === f.key ? "border-zinc-600 bg-zinc-800 text-zinc-100" : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300",
              )}
            >
              {f.label}
              {f.key === "problems" && problems > 0 && (
                <span className="flex items-center gap-1 rounded-full bg-red-950/70 px-1.5 text-[10px] text-red-300 tabular-nums">
                  <span className="inline-block size-1.5 rounded-full bg-red-500" />
                  {problems}
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setNoise((v) => !v)}
            aria-pressed={noise}
            title="Показать debug-строки и шум"
            className={cn(
              "flex h-11 shrink-0 items-center gap-1 rounded-full border px-2.5 font-mono text-[11px] transition-colors sm:h-8",
              noise ? "border-amber-800 bg-amber-950/40 text-amber-300" : "border-zinc-800 text-zinc-600 hover:text-zinc-400",
            )}
          >
            <Bug className="size-3" />
            шум
          </button>
        </div>
        <div className="relative hidden min-w-0 w-56 sm:block">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-600" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="поиск по тексту и JSON…"
            aria-label="Поиск по логу"
            className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-950 pl-8 pr-2 font-mono text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
          />
        </div>
      </div>

      {/* лента */}
      <div className="relative">
        <div
          ref={boxRef}
          onScroll={onScroll}
          className={cn("h-[52svh] min-h-56 overflow-y-auto px-1 py-1.5 sm:h-[26rem] sm:px-2", showBanner && visible.length > 0 && "opacity-75")}
        >
          {visible.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
              {clearedAt > 0 && merged.some((e) => e.ts < clearedAt) ? (
                <>
                  <p className="font-mono text-[11px] text-zinc-500">лог очищен</p>
                  <button
                    type="button"
                    className="font-mono text-[11px] text-sky-400 underline decoration-sky-800 underline-offset-2 hover:text-sky-300"
                    onClick={() => setClearedAt(0)}
                  >
                    вернуть хвост ({merged.filter((e) => e.ts < clearedAt).length} строк)
                  </button>
                </>
              ) : (
                <>
                  <Waves className="size-5 text-zinc-700" aria-hidden />
                  <p className="max-w-xs font-mono text-[11px] leading-relaxed text-zinc-600">
                    {offline || showBanner
                      ? `связь с колонкой потеряна${conn?.lostAt ? ` в ${timeStr(conn.lostAt)}` : ""} — поток подхватится сам, когда станция вернётся в сеть`
                      : query.trim() || filter !== "all"
                        ? `по запросу «${query.trim() || FILTERS.find((f) => f.key === filter)?.label}» совпадений нет (скрыто ${hiddenCount} строк)`
                        : "на связи, ждём событий. Скажите что-нибудь колонке — реплика и маршрут сразу появятся здесь."}
                  </p>
                  {(query.trim() || filter !== "all") && !offline && !showBanner && (
                    <button
                      type="button"
                      className="font-mono text-[11px] text-sky-400 underline decoration-sky-800 underline-offset-2 hover:text-sky-300"
                      onClick={() => {
                        setQuery("");
                        setFilter("all");
                      }}
                    >
                      сбросить фильтр
                    </button>
                  )}
                </>
              )}
            </div>
          ) : (
            visible.map((r, i) => {
              const v = kindVisual(r.kind, r.event.json);
              const Icon = r.level === "error" ? CircleAlert : r.level === "warn" ? TriangleAlert : v.icon;
              const open = openKey === r.key;
              // визуальная связка голосового раунда (спека §1.4.3)
              const prev = i > 0 ? visible[i - 1] : null;
              const sameTurn =
                prev !== null &&
                DIALOG_KINDS.includes(prev.kind) &&
                DIALOG_KINDS.includes(r.kind) &&
                r.firstTs - prev.lastTs < TURN_GAP_MS;
              return (
                <div key={`${r.key}@${r.firstTs}`} className={cn("border-b border-zinc-900 last:border-b-0", sameTurn ? "ml-1.5 border-l border-zinc-800 pl-1" : "mt-1.5")}>
                  <button
                    type="button"
                    onClick={() => {
                      // раскрытие отключает автоскролл, чтобы поток не уносил открытый JSON (§1.5)
                      if (!open) setStick(false);
                      setOpenKey(open ? null : r.key);
                    }}
                    aria-expanded={open}
                    className={cn(
                      "flex w-full min-h-11 flex-col items-start gap-0.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-zinc-900/60 sm:min-h-8 sm:flex-row sm:items-center sm:gap-2 sm:py-1",
                      r.level === "warn" && "border-l-2 border-l-amber-400 bg-amber-950/15",
                      r.level === "error" && "border-l-2 border-l-red-500 bg-red-950/20",
                    )}
                  >
                    {/* строка 1 (мета): время · иконка + пилюля · метрика · ×N · шеврон */}
                    <span className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto sm:shrink-0">
                      <span className="shrink-0 font-mono text-[11px] text-zinc-500 tabular-nums" title={new Date(r.firstTs).toLocaleString("ru-RU", { hour12: false })}>
                        {timeStr(r.firstTs)}
                      </span>
                      <Icon className={cn("size-3.5 shrink-0", r.level === "warn" ? "text-amber-400" : r.level === "error" ? "text-red-400" : v.iconCls)} aria-hidden />
                      <span className={cn("shrink-0 rounded border px-1 py-px font-mono text-[9px] leading-4", v.pillCls)}>{KIND_LABEL[r.kind]}</span>
                      {r.event.metric && <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-500 tabular-nums sm:hidden">{r.event.metric}</span>}
                      {r.count > 1 && (
                        <span className="shrink-0 rounded-full bg-zinc-800 px-1.5 font-mono text-[10px] text-zinc-300 tabular-nums" title={`повторов: ${r.count}`}>
                          ×{r.count}
                        </span>
                      )}
                      <ChevronRight className={cn("size-3 shrink-0 text-zinc-600 transition-transform", open && "rotate-90")} aria-hidden />
                    </span>
                    {/* строка 2 (суть) */}
                    <span className={cn("min-w-0 flex-1 break-words text-[13px] leading-snug sm:text-xs", LEVEL_TEXT[r.level], r.mine && "text-sky-300")}>
                      <Highlight text={r.event.title} q={query} />
                    </span>
                    {r.event.metric && <span className="hidden shrink-0 font-mono text-[10px] text-zinc-500 tabular-nums sm:inline">{r.event.metric}</span>}
                  </button>
                  {open && (
                    <div className="mx-1 mb-2 overflow-hidden rounded-lg border border-zinc-800/90 bg-zinc-950 my-1">
                      <p className="flex flex-wrap items-center gap-x-2 border-b border-zinc-800/70 px-2.5 py-1.5 font-mono text-[10px] text-zinc-600">
                        <span>
                          источник: {r.event.json?.msg ? "quasar-bridge" : sourceByKey(source).stream}
                          {r.event.seq !== undefined ? ` · seq #${r.event.seq}` : ""}
                        </span>
                        <span>{new Date(r.lastTs).toLocaleString("ru-RU", { hour12: false })}</span>
                        <button
                          type="button"
                          onClick={() => copyText(prettyRaw(r.event), "one")}
                          className="ml-auto flex items-center gap-1 rounded border border-zinc-800 px-1.5 py-0.5 text-zinc-500 transition-colors hover:border-zinc-600 hover:text-zinc-300"
                        >
                          {copied === "one" ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                          {copied === "one" ? "скопировано ✓" : "копировать JSON"}
                        </button>
                      </p>
                      {r.count > 1 && (
                        <p className="border-b border-zinc-800/70 px-2.5 py-1.5 font-mono text-[10px] text-zinc-500">
                          первое: {timeStr(r.firstTs)} · последнее: {timeStr(r.lastTs)} ({r.count} событий) — ниже последнее
                        </p>
                      )}
                      <pre className="max-h-64 overflow-auto p-2.5 font-mono text-[11px] leading-relaxed">
                        {r.event.json ? (
                          highlightJson(prettyRaw(r.event)).map((t, i) =>
                            t.cls ? (
                              <span key={i} className={t.cls}>
                                {t.text}
                              </span>
                            ) : (
                              <span key={i} className="text-zinc-400">
                                {t.text}
                              </span>
                            ),
                          )
                        ) : (
                          <span className="whitespace-pre-wrap break-words text-zinc-400">{r.event.raw}</span>
                        )}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })
          )}
          {showBanner && visible.length > 0 && (
            <div role="status" className="sticky bottom-1 mx-1 mt-2 flex items-center gap-2 rounded-lg border border-amber-900/50 bg-amber-950/40 px-3 py-2 text-xs text-amber-200/90">
              <WifiOff className="size-3.5 shrink-0 text-amber-400" />
              связь с колонкой потеряна{conn?.lostAt ? ` в ${timeStr(conn.lostAt)}` : ""} — поток подхватится сам, когда станция вернётся в сеть
            </div>
          )}
        </div>
        {away && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={toEnd}
            className="absolute right-3 bottom-3 z-10 h-11 gap-1.5 font-mono text-[11px] shadow-lg sm:h-8"
          >
            <ArrowDown className="size-3.5" />
            {paused && pendingCount > 0 ? `в конец · +${pendingCount}` : "в конец"}
          </Button>
        )}
      </div>
    </section>
  );
}

/** Последняя осмысленная строка исключения из многострочного стека. */
function lastMeaningfulLine(raw: string): string {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/^(Traceback|File "|at |\s)/.test(l)) continue;
    if (/[\wа-яё]$/i.test(l)) return l.length > 160 ? `${l.slice(0, 157)}…` : l;
  }
  return lines[lines.length - 1]?.slice(0, 160) ?? raw.slice(0, 160);
}

interface Props {
  stationId: string;
  local?: LocalLine[];
  /** Колонка не на связи — лог «в ожидании», подключение остаётся (EventSource сам переподключается). */
  offline?: boolean;
}
