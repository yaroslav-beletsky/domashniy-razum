import { NextRequest } from "next/server";
import { agentFetch } from "@/lib/agentApi";
import { badJson, readJson, respond } from "@/lib/agentRoutes";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const idOf = async (ctx: Ctx) => String(Number((await ctx.params).id) || 0);

/** { enabled?, url?, cmd?, timeout_ms?, secret_refs? } */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const body = await readJson(req);
  if (!body) return badJson();
  const allowed = ["name", "transport", "url", "cmd", "secret_refs", "enabled", "timeout_ms"];
  const fields = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
  const r = await agentFetch(`/mcp/${await idOf(ctx)}`, { method: "PATCH", body: fields });
  return respond(r, (d) => ({ server: d }));
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const r = await agentFetch(`/mcp/${await idOf(ctx)}`, { method: "DELETE" });
  return respond(r, () => ({}));
}
