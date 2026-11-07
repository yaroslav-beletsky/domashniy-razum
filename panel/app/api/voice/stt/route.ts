import { NextRequest, NextResponse } from "next/server";
import { voiceChainStt } from "@/lib/voiceChain";
import { recordEvent } from "@/lib/events";
import { appendLog } from "@/lib/logs";

export const dynamic = "force-dynamic";

/** STT: WAV → текст через голосовую цепочку (VOICE_CHAIN_URL, поле формы audio). */
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
  const result = await voiceChainStt(buf);

  if (!result.ok) {
    recordEvent("voice", `STT: ошибка — ${result.error}`);
    appendLog("error", "voice", `stt failed: ${result.error}`);
    return NextResponse.json({ ok: false, error: result.error ?? "voice-chain недоступен" }, { status: 502 });
  }

  recordEvent("voice", `STT: "${result.text?.slice(0, 60) ?? ""}" за ${result.ms} мс`);
  appendLog("info", "voice", `stt ok in ${result.ms}ms, text=${(result.text ?? "").length} chars`);
  return NextResponse.json({
    ok: true,
    ms: result.ms,
    text: result.text ?? "",
    language: result.language,
    confidence: result.confidence,
    durationMs: result.durationMs,
  });
}
