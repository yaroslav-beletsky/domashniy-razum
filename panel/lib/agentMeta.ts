// Метаданные агента, которых нет в agent-service (имя, аватар, описание). Файл на смонтированном томе
// рядом с реестром колонок: переживает пересборку контейнера. Секретов тут нет.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { AgentMeta } from "./agentTypes";

const FILE = process.env.AGENTS_META_FILE ?? path.join(config.adbHome, ".android", "panel-agents.json");

function read(): Record<string, AgentMeta> {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8")) as { agents?: Record<string, AgentMeta> };
    return j.agents && typeof j.agents === "object" ? j.agents : {};
  } catch {
    return {};
  }
}

function write(all: Record<string, AgentMeta>): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ agents: all }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch {
    /* метаданные необязательны: агент работает и без них */
  }
}

function clean(v: unknown, max: number): string | undefined {
  const s = String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
  return s || undefined;
}

export function sanitizeMeta(m: unknown): AgentMeta {
  const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
  return { name: clean(o.name, 32), avatar: clean(o.avatar, 8), description: clean(o.description, 120) };
}

export function getAllMeta(): Record<string, AgentMeta> {
  return read();
}

export function getMeta(slug: string): AgentMeta {
  return read()[slug] ?? {};
}

export function setMeta(slug: string, patch: unknown): AgentMeta {
  const all = read();
  const next = { ...(all[slug] ?? {}), ...sanitizeMeta(patch) };
  // пустое значение в patch стирает поле
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  for (const k of ["name", "avatar", "description"] as const) {
    if (k in p && !clean(p[k], 200)) delete next[k];
  }
  all[slug] = next;
  write(all);
  return next;
}

export function deleteMeta(slug: string): void {
  const all = read();
  if (slug in all) {
    delete all[slug];
    write(all);
  }
}
