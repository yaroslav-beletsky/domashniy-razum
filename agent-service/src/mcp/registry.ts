import type { AgentRow } from "../db.js";
import { agentToolsEnabled } from "../db.js";
import { cachedTools, listServers, refreshServer, callTool, resolveToolName, type ToolCallOutcome } from "./pool.js";
import { compress } from "./tools.js";

export interface AgentToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
  call: (args: unknown, timeoutMs: number) => Promise<ToolCallOutcome>;
}

export const BUILTIN_DATETIME = {
  type: "function" as const,
  function: {
    name: "builtin__datetime",
    description: "Текущие дата и время на сервере (UTC+3, Москва). Используй для вопросов о времени и дате.",
    parameters: {
      type: "object",
      properties: { format: { type: "string", description: "например HH:mm или DD.MM.YYYY" } },
      additionalProperties: false,
    },
  },
  call: async (args: any): Promise<ToolCallOutcome> => {
    const t0 = Date.now();
    const now = new Date();
    const fmt = args?.format;
    const pad = (n: number) => String(n).padStart(2, "0");
    const msk = new Date(now.getTime() + 3 * 3600_000);
    let text: string;
    if (fmt === "HH:mm") text = `${pad(msk.getUTCHours())}:${pad(msk.getUTCMinutes())}`;
    else if (fmt === "DD.MM.YYYY") text = `${pad(msk.getUTCDate())}.${pad(msk.getUTCMonth() + 1)}.${msk.getUTCFullYear()}`;
    else
      text = `${pad(msk.getUTCDate())}.${pad(msk.getUTCMonth() + 1)}.${msk.getUTCFullYear()} ${pad(msk.getUTCHours())}:${pad(msk.getUTCMinutes())} MSK`;
    return { ok: true, ms: Date.now() - t0, text };
  },
};

/**
 * Resolve the tool set for an agent: builtins + enabled MCP tools filtered by
 * agent.tools_enabled ("*" = all, [] = none).
 */
export async function collectTools(agent: AgentRow): Promise<AgentToolSpec[]> {
  const enabled = agentToolsEnabled(agent);
  if (enabled.length === 0) return [];
  const all = enabled.includes("*");
  const specs: AgentToolSpec[] = [];

  if (all || enabled.includes(BUILTIN_DATETIME.function.name)) {
    specs.push(BUILTIN_DATETIME);
  }

  const servers = listServers().filter((s) => s.enabled);
  for (const server of servers) {
    let tools = cachedTools(server);
    if (tools.length === 0) {
      try {
        tools = await refreshServer(server.id);
      } catch {
        continue; // circuit breaker / offline — model sees "недоступно" via absence
      }
    }
    for (const t of tools) {
      if (!all && !enabled.includes(t.name)) continue;
      specs.push({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.schema },
        call: (args, timeoutMs) =>
          callTool(server.id, t.tool, args, timeoutMs).then((o) => ({
            ...o,
            text: o.ok ? compress(args === undefined ? o.text : o.text, 1500) : o.text,
          })),
      });
    }
  }
  return specs;
}

export { resolveToolName, compress };
