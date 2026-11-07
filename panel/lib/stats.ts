// Статистика запросов из БД LiteLLM (таблица "LiteLLM_SpendLogs").
// Панель подключена к той же docker-сети, что и litellm-db (home): DNS litellm-db.
// DSN — только в env (LITELLM_PG_DSN), наружу не отдаётся. Нет DSN/сети — offline штатно.
import pg from "pg";
import { config } from "./config";

export interface RouteStat {
  key: string;
  count: number;
  avgMs: number;
  within45: number; // доля ≤ 4.5 с
  failures: number;
}

export interface StatsSummary {
  ok: boolean;
  dbConfigured: boolean;
  generatedAt: number;
  windowHours: number;
  total: number;
  failures: number;
  within45Count: number;
  within45Share: number; // 0..1
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  ttftAvgMs: number | null;
  byModel: RouteStat[];
  byRoute: RouteStat[];
  error?: string;
}

let pool: pg.Pool | null = null;

function getPool(): pg.Pool | null {
  if (!config.pgDsn) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.pgDsn,
      max: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 8000,
    });
    pool.on("error", () => {});
  }
  return pool;
}

interface Row {
  key: string;
  count: number;
  avg_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  within45: number;
  failures: number;
}

function toRouteStat(r: Row): RouteStat {
  return {
    key: r.key,
    count: Number(r.count),
    avgMs: Math.round(Number(r.avg_ms ?? 0)),
    within45: r.count > 0 ? Number(r.within45) / Number(r.count) : 0,
    failures: Number(r.failures),
  };
}

/**
 * Агрегаты за окно (по умолчанию 24 ч).
 * byRoute: «llm» — запросы самой панели (маршрут llm), остальное по api-ключам
 * (колонка api_key хэширована — группируем по первым 8 символам как «ключ №…»).
 */
export async function getStats(windowHours = 24): Promise<StatsSummary> {
  const base: StatsSummary = {
    ok: false,
    dbConfigured: Boolean(config.pgDsn),
    generatedAt: Date.now(),
    windowHours,
    total: 0,
    failures: 0,
    within45Count: 0,
    within45Share: 0,
    avgMs: null,
    p50Ms: null,
    p95Ms: null,
    ttftAvgMs: null,
    byModel: [],
    byRoute: [],
  };
  const p = getPool();
  if (!p) return { ...base, error: "LITELLM_PG_DSN не задан" };

  try {
    const overall = await p.query<{
      total: number;
      failures: number;
      within45: number;
      avg_ms: number | null;
      p50_ms: number | null;
      p95_ms: number | null;
      ttft_avg_ms: number | null;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status <> 'success')::int AS failures,
              count(*) FILTER (WHERE status = 'success' AND "endTime" IS NOT NULL
                               AND extract(epoch FROM ("endTime"-"startTime"))*1000 <= 4500)::int AS within45,
              avg(extract(epoch FROM ("endTime"-"startTime"))*1000) FILTER (WHERE "endTime" IS NOT NULL) AS avg_ms,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ("endTime"-"startTime"))*1000) FILTER (WHERE "endTime" IS NOT NULL) AS p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM ("endTime"-"startTime"))*1000) FILTER (WHERE "endTime" IS NOT NULL) AS p95_ms,
              avg(extract(epoch FROM ("completionStartTime"-"startTime"))*1000) FILTER (WHERE "completionStartTime" IS NOT NULL) AS ttft_avg_ms
       FROM "LiteLLM_SpendLogs"
       WHERE "startTime" >= now() - make_interval(hours => $1)`,
      [windowHours],
    );

    const byModel = await p.query<Row>(
      `SELECT model AS key, count(*)::int AS count,
              avg(extract(epoch FROM ("endTime"-"startTime"))*1000) AS avg_ms,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ("endTime"-"startTime"))*1000) AS p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM ("endTime"-"startTime"))*1000) AS p95_ms,
              count(*) FILTER (WHERE status = 'success' AND "endTime" IS NOT NULL
                               AND extract(epoch FROM ("endTime"-"startTime"))*1000 <= 4500)::int AS within45,
              count(*) FILTER (WHERE status <> 'success')::int AS failures
       FROM "LiteLLM_SpendLogs"
       WHERE "startTime" >= now() - make_interval(hours => $1) AND "endTime" IS NOT NULL
       GROUP BY model ORDER BY count DESC LIMIT 10`,
      [windowHours],
    );

    const byRoute = await p.query<Row>(
      `SELECT CASE WHEN "call_type" = 'chat_completion' THEN 'llm (chat)'
                   ELSE coalesce("call_type", 'unknown') END AS key,
              count(*)::int AS count,
              avg(extract(epoch FROM ("endTime"-"startTime"))*1000) AS avg_ms,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ("endTime"-"startTime"))*1000) AS p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM ("endTime"-"startTime"))*1000) AS p95_ms,
              count(*) FILTER (WHERE status = 'success' AND "endTime" IS NOT NULL
                               AND extract(epoch FROM ("endTime"-"startTime"))*1000 <= 4500)::int AS within45,
              count(*) FILTER (WHERE status <> 'success')::int AS failures
       FROM "LiteLLM_SpendLogs"
       WHERE "startTime" >= now() - make_interval(hours => $1) AND "endTime" IS NOT NULL
       GROUP BY 1 ORDER BY count DESC LIMIT 10`,
      [windowHours],
    );

    const o = overall.rows[0];
    const total = Number(o?.total ?? 0);
    return {
      ...base,
      ok: true,
      total,
      failures: Number(o?.failures ?? 0),
      within45Count: Number(o?.within45 ?? 0),
      within45Share: total > 0 ? Number(o?.within45 ?? 0) / total : 0,
      avgMs: o?.avg_ms != null ? Math.round(Number(o.avg_ms)) : null,
      p50Ms: o?.p50_ms != null ? Math.round(Number(o.p50_ms)) : null,
      p95Ms: o?.p95_ms != null ? Math.round(Number(o.p95_ms)) : null,
      ttftAvgMs: o?.ttft_avg_ms != null ? Math.round(Number(o.ttft_avg_ms)) : null,
      byModel: byModel.rows.map(toRouteStat),
      byRoute: byRoute.rows.map(toRouteStat),
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message.slice(0, 200) : "db error" };
  }
}
