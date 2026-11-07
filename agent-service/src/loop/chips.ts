// Подстановка чипов {{…}} в системный промпт агента.
// Значения вычисляются ОДИН раз на запрос (см. runner.ts), поэтому все раунды
// tool-loop и запасная модель видят один и тот же промпт в рамках запроса.
//
// Поведение:
//  - {{time}} / {{date}} — локальное время/дата в момент запроса, ru-RU, читаемо
//    (TZ контейнера; docker-compose задаёт Europe/Moscow);
//  - {{room}} / {{station_name}} — из записи колонки в SQLite (stations.room / name;
//    station_name при пустом name падает на device, чтобы у реальной колонки
//    чип не вырезался);
//  - известный чип с пустым значением ВЫРЕЗАЕТСЯ (и подчищаются следы: «комната .»
//    → «комната.»), неизвестные чипы ({{user_name}} и т.п.) остаются как есть.
import type { StationRow } from "../db.js";

export const KNOWN_CHIPS = ["time", "date", "room", "station_name"] as const;
export type KnownChip = (typeof KNOWN_CHIPS)[number];
export type ChipValues = Partial<Record<KnownChip, string>>;

export interface ChipContext {
  now?: Date;
  station?: StationRow | null;
  /** Явная зона (Intl). Не задана — системный TZ процесса. */
  tz?: string;
}

/** «12:23» — без секунд, 24 ч. */
export function fmtTime(d: Date, tz?: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  }).format(d);
}

/** «суббота, 7 ноября 2026» (Intl даёт «…2026 г.» — хвост срезаем). */
export function fmtDate(d: Date, tz?: string): string {
  const s = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: tz,
  }).format(d);
  return s.replace(/\s*г\.?\s*$/, "").trim();
}

export function chipValues(ctx: ChipContext = {}): ChipValues {
  const now = ctx.now ?? new Date();
  const st = ctx.station ?? null;
  const room = st?.room?.trim() || undefined;
  // station_name: приоритет — человекочитаемое имя, иначе device (не пусто у реальной станции)
  const name = st?.name?.trim() || st?.device?.trim() || undefined;
  const v: ChipValues = { time: fmtTime(now, ctx.tz), date: fmtDate(now, ctx.tz) };
  if (room) v.room = room;
  if (name) v.station_name = name;
  return v;
}

/** Подчистить следы вырезанного чипа: сдвоенные пробелы, « .» → «.», «: ,» → «: », висячие «, » и тире. */
function tidy(s: string): string {
  let t = s.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/[ \t]+([,.;!?])/g, "$1"); // «комната .» → «комната.»
  t = t.replace(/([:;])[ \t]*[,;][ \t]*/g, "$1 "); // «Колонка: ,» → «Колонка: »
  t = t.replace(/([,;])([ \t]*[,;])+([ \t]|$)/g, "$1$3"); // «, ,» → «,»
  t = t.replace(/(^|\n)[ \t]*[,;][ \t]+/g, "$1"); // строка начинается с «, »
  t = t.replace(/(^|\n)[ \t]*[—–-][ \t]+/g, "$1"); // строка начинается с «— »
  t = t.replace(/[ \t]+$/gm, ""); // висячий пробел в конце строки
  return t;
}

/** Заменить чипы в шаблоне. `values[chip] === undefined` → известный чип вырезается. */
export function renderChips(template: string, values: ChipValues): string {
  if (!template.includes("{{")) return template;
  let cut = false;
  let out = template;
  for (const chip of KNOWN_CHIPS) {
    const re = new RegExp(`\\{\\{\\s*${chip}\\s*\\}\\}`, "gi");
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    const v = values[chip];
    if (v === undefined) {
      out = out.replace(re, () => "");
      cut = true;
    } else {
      out = out.replace(re, () => v); // replacer-функция: значение с $ не трактуется как шаблон
    }
  }
  // Неизвестные чипы ({{user_name}}, {{что угодно}}) не трогаем.
  return cut ? tidy(out) : out;
}
