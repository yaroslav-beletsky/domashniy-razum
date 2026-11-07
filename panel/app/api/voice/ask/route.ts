import { NextRequest, NextResponse } from "next/server";
import { voiceChainAsk } from "@/lib/voiceChain";
import { recordEvent } from "@/lib/events";
import { appendLog } from "@/lib/logs";

export const dynamic = "force-dynamic";

/** Полный круг: аудио → STT → LLM → TTS → аудио (ответ — WAV base64). */
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "ожидался multipart/form-data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "файл не передан (поле file)" }, { status: 400 });
  }
  if (file.size > 8 * 1024 * 1024) {
    return NextResponse.json({ ok: false, error: "файл больше 8 МБ" }, { status: 413 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const result = await voiceChainAsk(buf);

  if (!result.ok) {
    recordEvent("voice", `ASK: ошибка — ${result.error}${result.sttText ? ` (распознано: "${result.sttText.slice(0, 40)}")` : ""}`);
    appendLog("error", "voice", `ask failed: ${result.error}`);
    return NextResponse.json(
      { ok: false, error: result.error ?? "voice-chain недоступен", sttText: result.sttText, sttMs: result.sttMs },
      { status: 502 },
    );
  }

  recordEvent("voice", `ASK: полный круг за ${result.ms} мс, ответ ${result.replyWav?.length ?? 0} байт`);
  appendLog("info", "voice", `ask ok in ${result.ms}ms, reply ${result.replyWav?.length ?? 0} bytes`);
  return NextResponse.json({
    ok: true,
    ms: result.ms,
    replyWav: result.replyWav?.toString("base64"),
    replyText: result.replyText,
    sttText: result.sttText,
    sttMs: result.sttMs,
    llmMs: result.llmMs,
    ttsMs: result.ttsMs,
  });
}
