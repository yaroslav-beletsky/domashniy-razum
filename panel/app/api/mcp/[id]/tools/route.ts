import { NextRequest } from "next/server";
import { agentFetch } from "@/lib/agentApi";
import { respond } from "@/lib/agentRoutes";
import type { McpTool } from "@/lib/agentTypes";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const r = await agentFetch<{ server: string; status: string; tools: Array<McpTool & { schema?: unknown }> }>(
    `/mcp/${Number((await ctx.params).id) || 0}/tools`,
  );
  // схему параметров в список не тащим — UI хватает имени и описания
  return respond(r, (d) => ({
    server: d?.server,
    status: d?.status,
    tools: (d?.tools ?? []).map((t) => ({ name: t.name, tool: t.tool, description: t.description })),
  }));
}
