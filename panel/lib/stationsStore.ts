// Реестр колонок панели: ADB_DEVICES из env (+ имя/тип, заданные в UI) и добавленные из UI.
// Метаданные (комната, тип) лежат в JSON-файле на смонтированном томе — переживают пересборку.
// В файле нет секретов: только адрес, имя и тип.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { BridgeInfo } from "./station";

export type StationKind = "max" | "mini" | "lite" | "station2" | "unknown";
export const STATION_KINDS: StationKind[] = ["max", "mini", "lite", "station2", "unknown"];

/** Последнее известное состояние (для оффлайн-карточки: «была: модель»). */
export interface LastKnown {
  at: number;
  model?: string;
  mode?: string;
  ip?: string;
  firmware?: string;
  bridgeVersion?: string;
  /** MAC WiFi станции — чтобы панель находила её по текущему IP, а не по «застывшему» адресу */
  mac?: string;
}

export interface StationMeta {
  device: string; // host:port для adb
  name?: string;
  kind?: StationKind;
  extra: boolean; // добавлена из UI (можно удалить); колонки из env — нет
  last?: LastKnown;
}

interface FileEntry {
  device: string;
  name?: string;
  kind?: StationKind;
  extra?: boolean;
  last?: LastKnown;
}

const FILE = process.env.STATIONS_FILE ?? path.join(config.adbHome, ".android", "panel-stations.json");

function readFile(): FileEntry[] {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8")) as { stations?: FileEntry[] };
    return Array.isArray(j.stations) ? j.stations.filter((s) => typeof s?.device === "string") : [];
  } catch {
    return [];
  }
}

function writeFile(entries: FileEntry[]): string | null {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ stations: entries }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 120) : "не удалось записать реестр колонок";
  }
}

export function listStations(): StationMeta[] {
  const file = readFile();
  const byDevice = new Map(file.map((f) => [f.device, f]));
  const out: StationMeta[] = [];
  for (const device of config.adbDevices) {
    const f = byDevice.get(device);
    out.push({ device, name: f?.name, kind: f?.kind, extra: false, last: f?.last });
  }
  for (const f of file) {
    if (config.adbDevices.includes(f.device) || !f.extra) continue;
    out.push({ device: f.device, name: f.name, kind: f.kind, extra: true, last: f.last });
  }
  return out;
}

export function deviceToId(device: string): string {
  return device.replace(":", "-");
}

export function idToDevice(id: string | null | undefined): string | null {
  if (!id) return null;
  return listStations().find((s) => deviceToId(s.device) === id)?.device ?? null;
}

export function defaultName(device: string): string {
  const host = device.split(":")[0];
  const last = host.split(".").pop();
  return `Станция .${last}`;
}

const PRIVATE_IPV4 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

/** Адрес колонки из формы → host:port. Только частные IPv4 (панель не должна ходить по adb куда попало). */
export function parseDevice(host: string, port: number | string | undefined): { device?: string; error?: string } {
  const h = String(host ?? "").trim();
  const p = Number(port ?? 5555);
  if (!PRIVATE_IPV4.test(h) || h.split(".").some((o) => Number(o) > 255)) {
    return { error: "нужен локальный IPv4 (192.168.x.x, 10.x.x.x, 172.16–31.x.x)" };
  }
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: "порт 1–65535" };
  return { device: `${h}:${p}` };
}

function cleanName(v: unknown): string | undefined {
  const s = String(v ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
  return s || undefined;
}

export function addStation(device: string, name?: string, kind?: StationKind): { ok: boolean; error?: string } {
  if (listStations().some((s) => s.device === device)) return { ok: false, error: "такая колонка уже есть" };
  const entries = readFile().filter((f) => f.device !== device);
  entries.push({ device, name: cleanName(name), kind: kind && STATION_KINDS.includes(kind) ? kind : "unknown", extra: true });
  const err = writeFile(entries);
  return err ? { ok: false, error: err } : { ok: true };
}

export function updateStation(device: string, patch: { name?: string; kind?: string }): { ok: boolean; error?: string } {
  const meta = listStations().find((s) => s.device === device);
  if (!meta) return { ok: false, error: "колонка не найдена" };
  const entries = readFile();
  let e = entries.find((f) => f.device === device);
  if (!e) {
    e = { device, extra: meta.extra };
    entries.push(e);
  }
  if (patch.name !== undefined) e.name = cleanName(patch.name);
  if (patch.kind !== undefined) {
    if (!STATION_KINDS.includes(patch.kind as StationKind)) return { ok: false, error: "тип: max | mini | lite | station2 | unknown" };
    e.kind = patch.kind as StationKind;
  }
  const err = writeFile(entries);
  return err ? { ok: false, error: err } : { ok: true };
}

export function removeStation(device: string): { ok: boolean; error?: string } {
  const meta = listStations().find((s) => s.device === device);
  if (!meta) return { ok: false, error: "колонка не найдена" };
  if (!meta.extra) return { ok: false, error: "колонка задана в ADB_DEVICES (.env) — удалите её там" };
  const err = writeFile(readFile().filter((f) => f.device !== device));
  return err ? { ok: false, error: err } : { ok: true };
}

/** Запоминаем последнее онлайн-состояние (пишем в файл только при изменении, не чаще раза в минуту). */
let lastWrite = 0;
export function rememberStatus(device: string, info: BridgeInfo): void {
  const meta = listStations().find((s) => s.device === device);
  if (!meta) return;
  const next: LastKnown = {
    at: Date.now(),
    model: info.model,
    mode: info.mode,
    ip: info.ip,
    firmware: info.firmware,
    bridgeVersion: info.bridgeVersion,
    mac: info.mac,
  };
  const prev = meta.last;
  const same =
    prev && prev.model === next.model && prev.mode === next.mode && prev.ip === next.ip &&
    prev.firmware === next.firmware && prev.bridgeVersion === next.bridgeVersion && prev.mac === next.mac;
  if (same && Date.now() - lastWrite < 60000) return;
  if (same) return;
  const entries = readFile();
  let e = entries.find((f) => f.device === device);
  if (!e) {
    e = { device, extra: meta.extra };
    entries.push(e);
  }
  e.last = next;
  if (!writeFile(entries)) lastWrite = Date.now();
}
