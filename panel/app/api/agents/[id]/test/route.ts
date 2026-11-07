// Тест-панель: POST { prompt, voice? } → SSE из agent-service как есть
// (round, tool_call{name,ms,ok}, delta{text}, fallback, done{…}, error). Работает по сохранённому конфигу.
import { NextRequest, NextResponse } from "next/server";
import { agentStream, resolveAgentId } from "@/lib/agentApi";
import { badJson, notFound, readJson } from "@/lib/agentRoutes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const id = await resolveAgentId((await ctx.params).id);
  if (id === null) return notFound("агент не найден");
  const body = await readJson(req);
  if (!body) return badJson();
  const prompt = String(body.prompt ?? "").trim().slice(0, 2000);
  if (!prompt) return NextResponse.json({ ok: false, error: "пустой запрос" }, { status: 400 });
  return agentStream(`/agents/${id}/test`, { prompt, voice: body.voice !== false }, req.signal);
}
