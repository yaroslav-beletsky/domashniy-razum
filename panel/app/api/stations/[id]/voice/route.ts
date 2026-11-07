// Голос TTS колонки: мост-форк перед каждым ответом читает /data/opt/quasar-bridge/tts.override
// (одна строка вида «voice=ermil» или «voice=ermil@good») — применение мгновенное, рестарт не нужен.
// GET — текущее значение (+ установлен ли мост-форк); POST {voice} — записать/удалить файл
// (пусто или «default» → файл удаляется, колонка говорит штатным женским голосом).
import { NextRequest, NextResponse } from "next/server";
import { adbExec } from "@/lib/adb";
import { isApplying } from "@/lib/station";
import { idToDevice } from "@/lib/stationsStore";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const BRIDGE_DIR = "/data/opt/quasar-bridge";
const OVERRIDE = `${BRIDGE_DIR}/tts.override`;
const CMD_TIMEOUT_MS = 10000;

/** Список голосов моста (мужские и женские) и эмоции-суффиксы. */
const VOICES = ["ermil", "zahar", "oksana", "jane", "shitova", "omazh"] as const;
const EMOTIONS = ["good", "neutral"] as const;

/**
 * Нормализация значения: «ermil@good» → «ermil@good», «default»/пусто → null (файл удалить).
 * Строгий белый список — значение подставляется в shell-команду, ничего лишнего не пройдёт.
 */
function normalizeVoice(raw: string): string | null | "invalid" {
  const v = raw.trim().toLowerCase();
  if (!v || v === "default") return null;
  if (!/^[a-z]+(@[a-z]+)?$/.test(v)) return "invalid";
  const at = v.indexOf("@");
  const base = at < 0 ? v : v.slice(0, at);
  const emo = at < 0 ? "" : v.slice(at + 1);
  if (!(VOICES as readonly string[]).includes(base)) return "invalid";
  if (emo && !(EMOTIONS as readonly string[]).includes(emo)) return "invalid";
  return emo ? `${base}@${emo}` : base;
}

/** Прочитать tts.override + факт установки мост-форка одной shell-командой. */
async function readOverride(device: string): Promise<{ ok: boolean; installed: boolean; voice: string | null; error?: string }> {
  const cmd = `if [ -d ${BRIDGE_DIR} ]; then echo BRIDGE=1; cat ${OVERRIDE} 2>/dev/null; else echo BRIDGE=0; fi`;
  const r = await adbExec(["-s", device, "shell", cmd], CMD_TIMEOUT_MS);
  if (!r.ok) {
    const s = (r.stderr || r.stdout).replace(/^Command failed:[^\n]*\n?/, "").trim();
    return { ok: false, installed: false, voice: null, error: s.slice(0, 200) || "колонка не отвечает по adb" };
  }
  const installed = r.stdout.includes("BRIDGE=1");
  const m = r.stdout.match(/^voice=(\S+)\s*$/m);
  return { ok: true, installed, voice: installed && m ? m[1] : null };
}

function shortError(err: string | undefined): string {
  const s = (err ?? "").trim();
  if (/offline|not found|no devices/i.test(s)) return "станция не на связи — проверьте adb-подключение";
  if (/unauthorized/i.test(s)) return "колонка отклонила ключ панели (unauthorized)";
  return s.slice(0, 200) || "adb вернул ошибку";
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const device = idToDevice((await ctx.params).id);
  if (!device) return NextResponse.json({ ok: false, error: "колонка не найдена" }, { status: 404 });
  const v = await readOverride(device);
  if (!v.ok) return NextResponse.json({ ok: false, installed: false, voice: null, error: shortError(v.error) }, { status: 502 });
  return NextResponse.json({ ok: true, installed: v.installed, voice: v.voice });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const device = idToDevice((await ctx.params).id);
  if (!device) return NextResponse.json({ ok: false, error: "колонка не найдена" }, { status: 404 });

  let body: { voice?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const target = normalizeVoice(String(body.voice ?? ""));
  if (target === "invalid") {
    return NextResponse.json(
      { ok: false, error: `голос: ${VOICES.join(" | ")} (+ «@good»/«@neutral») или default` },
      { status: 400 },
    );
  }
  if (isApplying(device)) {
    return NextResponse.json({ ok: false, error: "панель сейчас применяет настройки на этой колонке — подождите несколько секунд" }, { status: 409 });
  }

  // мост-форк установлен? без него tts.override никто не прочитает
  const chk = await adbExec(["-s", device, "shell", `if [ -d ${BRIDGE_DIR} ]; then echo yes; else echo no; fi`], CMD_TIMEOUT_MS);
  if (!chk.ok) return NextResponse.json({ ok: false, error: shortError(chk.stderr || chk.stdout) }, { status: 502 });
  if (!chk.stdout.includes("yes")) {
    return NextResponse.json({ ok: false, installed: false, error: "мост-форк не установлен на колонке" }, { status: 409 });
  }

  // null → удалить файл (штатный женский), иначе записать одну строку «voice=…».
  // target прошёл белый список ([a-z]+ и @good/@neutral), так что в shell попадает только он.
  const cmd = target === null ? `rm -f ${OVERRIDE}` : `echo 'voice=${target}' > ${OVERRIDE}`;
  const w = await adbExec(["-s", device, "shell", cmd], CMD_TIMEOUT_MS);
  if (!w.ok) return NextResponse.json({ ok: false, error: shortError(w.stderr || w.stdout) }, { status: 502 });

  // перечитываем: отвечаем фактическим состоянием файла, а не надеждой
  const v = await readOverride(device);
  if (!v.ok) return NextResponse.json({ ok: false, error: shortError(v.error) }, { status: 502 });
  const applied = target === null ? v.voice === null : v.voice === target;
  return NextResponse.json({ ok: applied, installed: v.installed, voice: v.voice, error: applied ? undefined : "не удалось применить — файл не совпал" }, { status: applied ? 200 : 500 });
}
