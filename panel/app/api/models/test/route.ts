import { NextRequest, NextResponse } from "next/server";
import { chatTest } from "@/lib/litellm";
import { recordEvent } from "@/lib/events";
import { appendLog } from "@/lib/logs";

export const dynamic = "force-dynamic";

const DEFAULT_PROMPT = "Ответь одним словом: работает?";

export async function POST(req: NextRequest) {
  let model = "";
  let prompt = DEFAULT_PROMPT;
  try {
    const body = (await req.json()) as { model?: string; prompt?: string };
    model = String(body.model ?? "").slice(0, 200);
    if (body.prompt !== undefined) prompt = String(body.prompt).slice(0, 4000);
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  if (!model) {
    return NextResponse.json({ ok: false, error: "model required" }, { status: 400 });
  }

  const result = await chatTest(model, prompt, 30000);

  if (result.ok) {
    recordEvent(
      "model-test",
      `тест ${model}: ok, ${result.ms} мс, ${result.chars} симв.${result.overDialogsTimeLimit ? " (превышен лимит 4.5 с)" : ""}`,
    );
    appendLog("info", "panel", `model-test ${model} ok in ${result.ms}ms (${result.chars} chars)`);
  } else {
    recordEvent("model-test", `тест ${model}: ошибка — ${result.error}`);
    appendLog("error", "panel", `model-test ${model} failed: ${result.error}`);
  }

  return NextResponse.json(result);
}
