import { NextRequest, NextResponse } from "next/server";
import { voiceChainTts } from "@/lib/voiceChain";
import { recordEvent } from "@/lib/events";
import { appendLog } from "@/lib/logs";

export const dynamic = "force-dynamic";

/** TTS: текст → WAV 22050 Гц (base64 для <audio> на клиенте). */
export async function POST(req: NextRequest) {
  let text = "";
  try {
    const body = (await req.json()) as { text?: string };
    text = String(body.text ?? "").trim().slice(0, 2000);
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json({ ok: false, error: "текст пуст" }, { status: 400 });
  }

  const result = await voiceChainTts(text);
  if (!result.ok) {
    recordEvent("voice", `TTS: ошибка — ${result.error}`);
    appendLog("error", "voice", `tts failed: ${result.error}`);
    return NextResponse.json({ ok: false, error: result.error ?? "voice-chain недоступен" }, { status: 502 });
  }

  recordEvent("voice", `TTS: ok, ${result.ms} мс, ${result.wav?.length ?? 0} байт`);
  appendLog("info", "voice", `tts ok in ${result.ms}ms, ${result.wav?.length ?? 0} bytes`);
  return NextResponse.json({ ok: true, ms: result.ms, wav: result.wav?.toString("base64"), bytes: result.wav?.length ?? 0 });
}
