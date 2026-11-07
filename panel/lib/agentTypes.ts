// Типы и чистые хелперы раздела «Агенты». Без Node-зависимостей (импортируется и в клиенте).

export interface AgentMeta {
  name?: string;
  avatar?: string;
  description?: string;
}

/** Агент как его отдаёт agent-service (tools_enabled уже массив). */
export interface Agent {
  id: number;
  slug: string;
  system_prompt: string;
  model: string;
  fallback_model: string | null;
  tools_enabled: string[];
  max_rounds: number;
  budget_ms: number;
  max_tokens: number;
  memory_turns: number;
  memory_ttl_s: number;
  version: number;
  created_at: number;
  updated_at: number;
  stations_bound?: number;
}

/** Строка списка: агент + метаданные панели + сводка. */
export interface AgentView extends Agent {
  meta: AgentMeta;
  title: string;
  toolCount: number;
  mcpTotal: number;
  mcpErr: number;
  /** названия колонок, привязанных к агенту в agent-service */
  rooms: string[];
}

export interface McpServer {
  id: number;
  name: string;
  transport: "http" | "sse" | "stdio";
  url: string | null;
  cmd: string | null;
  secret_refs: string[];
  enabled: number;
  timeout_ms: number;
  status: string;
  tools: number;
  last_check_at: number | null;
}

export interface McpTool {
  name: string; // server__tool
  tool: string;
  description: string;
  schema?: unknown;
}

export const BUILTIN_TOOLS: McpTool[] = [
  { name: "builtin__datetime", tool: "datetime", description: "Текущие дата и время (МСК)" },
];

export const AGENT_PREFIX = "agent:";

/** Модель колонки вида `agent:<slug>` → slug. */
export function agentSlugFromModel(model: string | undefined | null): string | undefined {
  if (!model || !model.startsWith(AGENT_PREFIX)) return undefined;
  const slug = model.slice(AGENT_PREFIX.length).trim();
  return slug || undefined;
}

export function agentTitle(a: { slug: string }, meta?: AgentMeta): string {
  return meta?.name?.trim() || a.slug;
}

/** Лимит ответа → max_tokens (русский ≈ 2.5 симв./токен). */
export const ANSWER_LIMITS = [
  { id: "short", label: "1–2 фразы", hint: "~250 симв.", maxTokens: 100 },
  { id: "mid", label: "Абзац", hint: "~500 симв.", maxTokens: 200 },
  { id: "long", label: "До лимита Диалогов", hint: "~950 симв.", maxTokens: 380 },
] as const;

export function limitFromTokens(n: number): (typeof ANSWER_LIMITS)[number]["id"] | "custom" {
  return ANSWER_LIMITS.find((l) => l.maxTokens === n)?.id ?? "custom";
}

export const PROMPT_VARS = ["{{station_name}}", "{{room}}", "{{time}}", "{{date}}"] as const;

export const AVATARS = ["🏠", "🦉", "⚡", "🤖", "🧸", "🎧", "🌿", "🔧", "📚", "🍳", "🌙", "🎲"];

export const TEMPLATES = [
  { id: "blank", label: "Пустой", hint: "Без промпта — напишете сами", avatar: "🤖", prompt: "" },
  {
    id: "home",
    label: "Домашний помощник",
    hint: "Коротко, по делу, без воды",
    avatar: "🏠",
    prompt:
      "Ты домашний помощник. Отвечай по делу и доброжелательно, одной-двумя фразами. Числа и единицы пиши словами. Если нужны данные — вызови подходящий инструмент, а не выдумывай.",
  },
  {
    id: "storyteller",
    label: "Детский рассказчик",
    hint: "Добрые короткие истории",
    avatar: "🦉",
    prompt:
      "Ты добрый рассказчик для детей. Говори простыми словами, тёплым тоном. Истории короткие, без страшного. Сначала суть, потом детали.",
  },
] as const;

/** Эвристика «инструмент что-то меняет» — для янтарного бейджа «действие». */
export function isActionTool(tool: string): boolean {
  return /(^|_|-)(set|call|turn|toggle|open|close|lock|unlock|delete|remove|create|send|write|run|exec|restart|reboot|start|stop|press|play|pause|add|update)/i.test(
    tool,
  );
}

const TR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Имя → slug агента (`^[a-z0-9][a-z0-9_-]{1,60}$`). */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .split("")
    .map((ch) => TR[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 40);
  return s.length >= 2 ? s : "";
}

/** Сколько инструментов доступно агенту. `*` = всё из включённых серверов + builtin. */
export function countTools(enabled: string[], servers: Array<Pick<McpServer, "enabled" | "tools" | "name">>): number {
  if (enabled.includes("*")) return 1 + servers.filter((s) => s.enabled).reduce((n, s) => n + s.tools, 0);
  return enabled.length;
}
