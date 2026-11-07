// POST /api/stations/[id]/adb/exec — выполнить adb shell на колонке (консоль в UI).
// Выполнение через execFile без host-shell, так что команда уходит только на устройство.
// Ограничения: одна команда ≤ 400 символов без переносов; вывод ≤ 64 КБ; таймаут ≤ 30 с.
// Опасные команды требуют confirm:true от клиента (428), во время apply — 409.
import { NextRequest, NextResponse } from "next/server";
import { adbExec } from "@/lib/adb";
import { maskSecrets } from "@/lib/logSources";
import { isApplying } from "@/lib/station";
import { idToDevice } from "@/lib/stationsStore";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const MAX_CMD = 400;
const MAX_OUT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;

/** Опасные действия: перезагрузка/питание, удаление/перезапись, остановка моста/сети. */
const DANGEROUS: Array<{ re: RegExp; why: string }> = [
  { re: /\b(reboot|poweroff|halt|shutdown)\b/, why: "перезагрузит/выключит колонку" },
  { re: /\brm\s+(-[rRf]|.*quasar-bridge)/, why: "удалит файлы на колонке" },
  { re: />\s*\/data\/opt\/quasar-bridge\/(config\.json|runtime\.env)/, why: "перезапишет конфигурацию моста" },
  { re: /\b(dd|mkfs)\b/, why: "разрушительно для разделов" },
  { re: /\b(kill|killall|pkill)\b/, why: "остановит процессы на колонке" },
  { re: /control\.sh\s+stop/, why: "остановит мост" },
  { re: /\bstop\s+adbd\b/, why: "оборвёт adb-связь с колонкой" },
  { re: /\bifconfig\s+\S+\s+down\b/, why: "поднимет сеть колонки" },
];

function humanError(stderr: string, ms: number, timeoutMs: number): string {
  if (ms >= timeoutMs - 1500) return `таймаут ${Math.round(timeoutMs / 1000)} с — команда не успела (возможно, ждёт интерактивного ввода)`;
  const s = stderr.replace(/^Command failed:[^\n]*\n?/, "").trim();
  if (/unauthorized/i.test(s)) return "колонка отклонила ключ панели (unauthorized) — ключ adb не совпадает";
  if (/device.*(offline|not found)|no devices|more than one device/i.test(s)) return "станция не на связи — нажмите «Подключить»";
  if (/closed|reset|connection/i.test(s)) return "связь прервалась — попробуйте «Подключить» ещё раз";
  if (/not found\s*$/im.test(s) || /:\s+not found/i.test(s)) return `${s.split("\n")[0].slice(0, 160)} (утилиты нет в урезанном окружении колонки)`;
  return s.slice(0, 300) || "adb вернул ошибку";
}

function cut(s: string): string {
  return s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n…(вывод обрезан на 64 КБ)` : s;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const device = idToDevice(id);
  if (!device) return NextResponse.json({ ok: false, error: "колонка не найдена" }, { status: 404 });

  let body: { command?: string; confirm?: boolean; timeoutMs?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const cmd = String(body.command ?? "");
  if (!cmd.trim()) return NextResponse.json({ ok: false, error: "пустая команда" }, { status: 400 });
  if (cmd.length > MAX_CMD) return NextResponse.json({ ok: false, error: `команда длиннее ${MAX_CMD} символов` }, { status: 400 });
  if (/[\r\n\x00-\x08\x0b-\x1f]/.test(cmd)) return NextResponse.json({ ok: false, error: "переносы строк и управляющие символы запрещены — по одной команде за раз" }, { status: 400 });

  const why = DANGEROUS.find((d) => d.re.test(cmd))?.why;
  if (why && body.confirm !== true) {
    return NextResponse.json({ ok: false, requiresConfirm: true, error: `«${cmd.slice(0, 80)}» ${why}. Подтвердите выполнение.` }, { status: 428 });
  }
  if (isApplying(device)) {
    return NextResponse.json({ ok: false, error: "панель сейчас применяет настройки на этой колонке — подождите несколько секунд" }, { status: 409 });
  }

  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS, 3000), MAX_TIMEOUT_MS);
  const r = await adbExec(["-s", device, "shell", cmd], timeoutMs, req.signal);
  if (r.aborted) {
    return NextResponse.json({ ok: false, stdout: "", stderr: "", ms: r.ms, device, error: "прервано вручную" });
  }
  return NextResponse.json({
    ok: r.ok,
    stdout: cut(maskSecrets(r.stdout)),
    stderr: maskSecrets(r.stderr).slice(0, 4000),
    ms: r.ms,
    device,
    error: r.ok ? undefined : humanError(r.stderr || r.stdout, r.ms, timeoutMs),
  });
}
