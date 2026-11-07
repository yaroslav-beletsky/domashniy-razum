"use client";

// Статистика LiteLLM за 24 ч (из БД spend logs) и лента событий панели.
// Переехали сюда со старого «Пульта» — вкладка «Диагностика» на странице агента.
import { useEffect, useState } from "react";
import { Sigma, Timer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Stats {
  ok: boolean;
  dbConfigured: boolean;
  windowHours: number;
  total: number;
  failures: number;
  within45Count: number;
  within45Share: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  ttftAvgMs: number | null;
  byModel: Array<{ key: string; count: number; avgMs: number; within45: number; failures: number }>;
  byRoute: Array<{ key: string; count: number; avgMs: number; within45: number; failures: number }>;
  error?: string;
}

export function StatsCard() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/stats?hours=24", { cache: "no-store" });
        if (r.ok) setStats(await r.json());
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const fmtMs = (v: number | null | undefined): string =>
    v == null ? "—" : v >= 10000 ? `${(v / 1000).toFixed(1)} с` : `${v} мс`;

  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">
          <Timer className="size-3.5" /> LiteLLM · статистика за 24 ч
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3">
        {stats === null ? (
          <div className="font-mono text-xs text-zinc-600">загрузка…</div>
        ) : !stats.ok ? (
          <div className="rounded border border-amber-900 bg-amber-950/30 px-3 py-2 font-mono text-xs text-amber-400">
            статистика недоступна: {stats.dbConfigured ? stats.error : "LITELLM_PG_DSN не задан"}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 font-mono sm:grid-cols-3 lg:grid-cols-6">
              <div>
                <div className="text-xl">{stats.total}</div>
                <div className="text-[10px] text-zinc-500">запросов</div>
              </div>
              <div>
                <div className="text-xl text-emerald-400">{stats.within45Count}</div>
                <div className="text-[10px] text-zinc-500">≤4.5 с ({pct(stats.within45Share)})</div>
              </div>
              <div>
                <div className="text-xl">{fmtMs(stats.avgMs)}</div>
                <div className="text-[10px] text-zinc-500">средняя latency</div>
              </div>
              <div>
                <div className="text-xl">{fmtMs(stats.p50Ms)}</div>
                <div className="text-[10px] text-zinc-500">p50</div>
              </div>
              <div>
                <div className="text-xl">{fmtMs(stats.p95Ms)}</div>
                <div className="text-[10px] text-zinc-500">p95</div>
              </div>
              <div>
                <div className={cn("text-xl", stats.failures > 0 ? "text-red-400" : "")}>{stats.failures}</div>
                <div className="text-[10px] text-zinc-500">ошибок</div>
              </div>
            </div>

            {stats.ttftAvgMs != null && (
              <div className="mt-2 font-mono text-[11px] text-zinc-500">
                TTFT (completionStart − start): в среднем {fmtMs(stats.ttftAvgMs)}
              </div>
            )}

            {stats.byModel.length > 0 && (
              <div className="mt-3">
                <div className="mb-1.5 font-mono text-[11px] tracking-wide text-zinc-500 uppercase">по моделям</div>
                {/* Десктоп: таблица */}
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full font-mono text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800 text-left text-[10px] text-zinc-600 uppercase">
                        <th className="py-1 pr-3 font-normal">модель</th>
                        <th className="py-1 pr-3 text-right font-normal">запросов</th>
                        <th className="py-1 pr-3 text-right font-normal">среднее</th>
                        <th className="py-1 pr-3 text-right font-normal">≤4.5 с</th>
                        <th className="py-1 text-right font-normal">ошибок</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byModel.map((m) => (
                        <tr key={m.key} className="border-b border-zinc-900">
                          <td className="py-1.5 pr-3 text-zinc-300">{m.key}</td>
                          <td className="py-1.5 pr-3 text-right">{m.count}</td>
                          <td className="py-1.5 pr-3 text-right">{fmtMs(m.avgMs)}</td>
                          <td className="py-1.5 pr-3 text-right">{pct(m.within45)}</td>
                          <td className={cn("py-1 text-right", m.failures > 0 && "text-red-400")}>{m.failures}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Мобайл: карточки */}
                <div className="flex flex-col gap-2 md:hidden">
                  {stats.byModel.map((m) => (
                    <div key={m.key} className="rounded border border-zinc-800 p-2 font-mono text-xs">
                      <div className="break-all text-zinc-300">{m.key}</div>
                      <div className="mt-1 flex flex-wrap gap-x-4 text-zinc-500">
                        <span>{m.count} запр.</span>
                        <span>ср. {fmtMs(m.avgMs)}</span>
                        <span className="text-emerald-400">≤4.5с {pct(m.within45)}</span>
                        {m.failures > 0 && <span className="text-red-400">ошибок {m.failures}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {stats.byRoute.length > 0 && (
              <div className="mt-3">
                <div className="mb-1.5 font-mono text-[11px] tracking-wide text-zinc-500 uppercase">по маршрутам (call_type)</div>
                <div className="flex flex-wrap gap-2">
                  {stats.byRoute.map((r) => (
                    <Badge key={r.key} variant="outline" className="h-6 gap-1.5 px-2 font-mono text-[11px] font-normal text-zinc-300">
                      {r.key} · {r.count}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        <div className="mt-2 font-mono text-[10px] text-zinc-600">
          источник: БД LiteLLM (LiteLLM_SpendLogs) · обновление раз в 30 с
        </div>
      </CardContent>
    </Card>
  );
}

interface PanelEvent {
  id: number;
  ts: number;
  kind: string;
  text: string;
}

const KIND_STYLE: Record<string, string> = {
  system: "text-zinc-400 border-zinc-700",
  litellm: "text-sky-300 border-sky-900",
  "model-test": "text-emerald-300 border-emerald-900",
  voice: "text-violet-300 border-violet-900",
  security: "text-amber-300 border-amber-900",
  station: "text-orange-300 border-orange-900",
};

function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString("ru-RU", { hour12: false });
}

export function EventsFeed({ className }: { className?: string }) {
  const [events, setEvents] = useState<PanelEvent[]>([]);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/events?limit=50", { cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          setEvents(j.events ?? []);
        }
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <Card className={className}>
      <CardHeader className="px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">
          <Sigma className="size-3.5" /> Лента событий
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3">
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto font-mono text-xs">
          {events.length === 0 && <div className="text-zinc-600">пусто</div>}
          {events.map((e) => (
            <div key={e.id} className="flex items-baseline gap-2">
              <span className="shrink-0 text-zinc-600">{timeStr(e.ts)}</span>
              <Badge
                variant="outline"
                className={cn("h-4 shrink-0 px-1 font-mono text-[10px] font-normal", KIND_STYLE[e.kind] ?? "text-zinc-400")}
              >
                {e.kind}
              </Badge>
              <span className="min-w-0 break-words text-zinc-300">{e.text}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
