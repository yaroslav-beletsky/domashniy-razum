import { NextRequest } from "next/server";
import { agentFetch } from "@/lib/agentApi";
import { respond } from "@/lib/agentRoutes";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Переподключиться и перечитать схему tools. */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const r = await agentFetch<{ status: string; tools: number }>(`/mcp/${Number((await ctx.params).id) || 0}/refresh`, {
    method: "POST",
    timeoutMs: 20000,
  });
  return respond(r, (d) => ({ status: d?.status, tools: d?.tools ?? 0 }));
}
