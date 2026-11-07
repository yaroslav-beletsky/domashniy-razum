// POST /api/stations/[id]/adb/terminal/input — ввод (нажатия клавиш, вставка) в adb shell.
// Тело: {"d":"<строка>"} — любой текст, включая управляющие байты (\r, \u007f, \u0003…).
// Лимит 16 КБ за запрос; клиент батчит нажатия, порядок гарантируем цепочкой промисов на фронте.
import { NextRequest, NextResponse } from "next/server";
import { terminalWrite } from "@/lib/adbTerminal";
import { idToDevice } from "@/lib/stationsStore";

export const dynamic = "force-dynamic";

const MAX_CHUNK = 16 * 1024;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const device = idToDevice(id);
  if (!device) return NextResponse.json({ ok: false, error: "колонка не найдена" }, { status: 404 });

  let body: { d?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const data = String(body.d ?? "");
  if (!data) return NextResponse.json({ ok: true });
  if (data.length > MAX_CHUNK) return NextResponse.json({ ok: false, error: "чанк слишком большой" }, { status: 413 });

  const written = await terminalWrite(device, data);
  return NextResponse.json({ ok: written });
}
