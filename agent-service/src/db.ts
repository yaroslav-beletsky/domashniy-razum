import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { ensureSecretsDir } from "./secrets.js";

ensureSecretsDir();
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
// НЕ WAL: база лежит на bind-mount через virtiofs (colima), где восстановление
// -wal между процессами ненадёжно — свежие коммиты терялись при recreate
// контейнера (подмена имени/комнаты колонки, ключи). Rollback-journal на этой
// ФС надёжен; нагрузка крошечная, цена — пара мс на запись.
db.pragma("journal_mode = DELETE");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  fallback_model TEXT,
  tools_enabled TEXT NOT NULL DEFAULT '[]',
  max_rounds INTEGER NOT NULL DEFAULT 3,
  budget_ms INTEGER NOT NULL DEFAULT 6000,
  max_tokens INTEGER NOT NULL DEFAULT 250,
  memory_turns INTEGER NOT NULL DEFAULT 6,
  memory_ttl_s INTEGER NOT NULL DEFAULT 300,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT UNIQUE NOT NULL,
  key_hash TEXT UNIQUE,
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  name TEXT,
  room TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('http','sse','stdio')),
  url TEXT,
  cmd TEXT,
  secret_refs TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  timeout_ms INTEGER NOT NULL DEFAULT 2500,
  status TEXT NOT NULL DEFAULT 'unknown',
  tools_cache TEXT,
  last_check_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  UNIQUE(station)
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  station_id INTEGER,
  agent_id INTEGER,
  event TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
`);

// Мягкая миграция существующих БД: stations.name / stations.room (для чипов
// {{station_name}} / {{room}} в системном промпте). CREATE TABLE IF NOT EXISTS
// уже существующую таблицу не расширяет.
{
  const cols = (db.prepare("PRAGMA table_info(stations)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("name")) db.exec("ALTER TABLE stations ADD COLUMN name TEXT");
  if (!cols.includes("room")) db.exec("ALTER TABLE stations ADD COLUMN room TEXT");
}

export const now = () => Date.now();

const insAudit = db.prepare(
  "INSERT INTO audit (ts, station_id, agent_id, event, meta) VALUES (?,?,?,?,?)"
);
export function audit(
  event: string,
  meta?: Record<string, unknown>,
  stationId?: number | null,
  agentId?: number | null
) {
  try {
    insAudit.run(now(), stationId ?? null, agentId ?? null, event,
      meta ? JSON.stringify(meta).slice(0, 4000) : null);
  } catch (e) {
    console.error("[audit] failed:", (e as Error).message);
  }
}

// ---------- row types ----------
export interface AgentRow {
  id: number;
  slug: string;
  system_prompt: string;
  model: string;
  fallback_model: string | null;
  tools_enabled: string; // JSON array
  max_rounds: number;
  budget_ms: number;
  max_tokens: number;
  memory_turns: number;
  memory_ttl_s: number;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface StationRow {
  id: number;
  device: string;
  key_hash: string | null;
  agent_id: number | null;
  /** Человекочитаемое имя колонки ({{station_name}}); пусто → device. */
  name: string | null;
  /** Комната ({{room}}). */
  room: string | null;
  created_at: number;
  updated_at: number;
}

export interface McpServerRow {
  id: number;
  name: string;
  transport: "http" | "sse" | "stdio";
  url: string | null;
  cmd: string | null;
  secret_refs: string; // JSON array of names
  enabled: number;
  timeout_ms: number;
  status: string;
  tools_cache: string | null;
  last_check_at: number | null;
}

export function agentToolsEnabled(a: AgentRow): string[] {
  try {
    const v = JSON.parse(a.tools_enabled);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function mcpSecretRefs(s: McpServerRow): string[] {
  try {
    const v = JSON.parse(s.secret_refs);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function getSession(station: string): Record<string, unknown> {
  const row = db.prepare("SELECT data, updated_at FROM sessions WHERE station = ?").get(station) as
    | { data: string; updated_at: number }
    | undefined;
  if (!row) return {};
  const ttl = 300_000;
  if (Date.now() - row.updated_at > ttl) return {};
  try {
    return JSON.parse(row.data);
  } catch {
    return {};
  }
}

export function setSession(station: string, data: Record<string, unknown>) {
  db.prepare(
    `INSERT INTO sessions (station, data, updated_at) VALUES (?,?,?)
     ON CONFLICT(station) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(station, JSON.stringify(data).slice(0, 20000), Date.now());
}

export function deleteSession(station: string): boolean {
  const r = db.prepare("DELETE FROM sessions WHERE station = ?").run(station);
  return r.changes > 0;
}
