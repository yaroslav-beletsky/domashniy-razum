// Человеческие имена моделей LiteLLM для UI (пикер модели, карточки колонок).
// Реальные id: `cp-self-zai-glm-5.3-flash`, `cp-homeae-claude-haiku-5-5`, `ag-gemini-3.8-flash`,
// `openrouter/openai/gpt-5.4:batch`, `vnc-video-seedance-2-fast`, `o3-mini-high` …
// Без сети и без состояния — чистые функции.

export interface ParsedModel {
  id: string;
  /** ключ группы провайдера (для сортировки/цвета) */
  providerKey: string;
  /** «Домашние», «OpenRouter», «AG» … */
  provider: string;
  /** подгруппа: для OpenRouter — вендор (openai, anthropic) */
  vendor?: string;
  /** чистое имя без префикса и без варианта */
  name: string;
  /** вариант: low / medium / high / free / batch … */
  variant?: string;
  /** имя + вариант целиком, без префикса */
  short: string;
}

const PREFIXES: Array<{ prefix: string; key: string; label: string }> = [
  { prefix: "cp-self-", key: "self", label: "Домашние" },
  { prefix: "cp-homeae-", key: "homeae", label: "Home AE" },
  { prefix: "coaib-", key: "coaib", label: "CoAIB" },
  { prefix: "cp-", key: "cp", label: "CP" },
  { prefix: "ag-", key: "ag", label: "AG" },
  { prefix: "cx-", key: "cx", label: "CX" },
  { prefix: "op-", key: "op", label: "OP" },
  { prefix: "vnc-", key: "vnc", label: "VNC" },
];

const VENDOR_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "meta-llama": "Meta Llama",
  meta: "Meta",
  mistralai: "Mistral",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  "x-ai": "xAI",
  "z-ai": "Z.ai",
  moonshotai: "Moonshot",
  nvidia: "NVIDIA",
  minimax: "MiniMax",
  cohere: "Cohere",
  amazon: "Amazon",
  xiaomi: "Xiaomi",
  bytedance: "ByteDance",
  "bytedance-seed": "ByteDance",
};

const VARIANT_RE = /^(.*?)(?:[-:](low|medium|high|minimal|xhigh|max|free|batch|exacto|thinking|nitro|floor))$/i;

function vendorLabel(v: string): string {
  const k = v.toLowerCase();
  return VENDOR_LABEL[k] ?? v.charAt(0).toUpperCase() + v.slice(1);
}

export function parseModel(id: string): ParsedModel {
  let rest = id;
  let providerKey = "other";
  let provider = "Другие";
  let vendor: string | undefined;

  if (id.startsWith("openrouter/")) {
    providerKey = "openrouter";
    provider = "OpenRouter";
    rest = id.slice("openrouter/".length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      vendor = vendorLabel(rest.slice(0, slash).replace(/^~/, ""));
      rest = rest.slice(slash + 1);
    }
  } else {
    const p = PREFIXES.find((x) => id.startsWith(x.prefix));
    if (p) {
      providerKey = p.key;
      provider = p.label;
      rest = id.slice(p.prefix.length);
    }
  }

  const m = VARIANT_RE.exec(rest);
  const name = m ? m[1] : rest;
  const variant = m ? m[2].toLowerCase() : undefined;
  return { id, providerKey, provider, vendor, name: name || rest, variant, short: rest };
}

/**
 * Приводит ответ /api/models к списку id. API отдаёт объекты `{id, object, owned_by}`,
 * но компоненты работают со строками; терпим оба формата и отбрасываем мусор и дубликаты
 * (дубликат id = дубликат React key в пикере).
 */
export function modelIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const m of input) {
    const id = typeof m === "string" ? m : m && typeof m === "object" ? (m as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id.trim()) out.add(id);
  }
  return [...out];
}

/** Короткое имя для карточки: без префикса провайдера, обрезка по длине. Полный id — в title. */
export function shortModelName(id: string | undefined, max = 28): string {
  if (!id) return "—";
  const s = parseModel(id).short;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export interface ModelRow {
  key: string; // id модели-представителя: React key и cmdk value
  name: string;
  /** модель, которая выбирается кликом по строке: без варианта, если есть; иначе первый вариант */
  primary: ParsedModel;
  /** варианты (low/medium/high, free/batch …) — мини-пилюли */
  variants: ParsedModel[];
  all: ParsedModel[];
}

export interface ModelGroup {
  key: string;
  label: string;
  providerKey: string;
  rows: ModelRow[];
}

const GROUP_ORDER = ["self", "homeae", "coaib", "cp", "ag", "cx", "op", "vnc", "openrouter", "other"];

/** Группировка по провайдеру/вендору; варианты схлопываются в одну строку. */
export function groupModels(ids: string[]): ModelGroup[] {
  const groups = new Map<string, { key: string; label: string; providerKey: string; rowMap: Map<string, ParsedModel[]> }>();
  for (const id of ids) {
    const p = parseModel(id);
    const gKey = p.vendor ? `${p.providerKey}:${p.vendor}` : p.providerKey;
    const gLabel = p.vendor ? `${p.provider} · ${p.vendor}` : p.provider;
    let g = groups.get(gKey);
    if (!g) {
      g = { key: gKey, label: gLabel, providerKey: p.providerKey, rowMap: new Map() };
      groups.set(gKey, g);
    }
    const list = g.rowMap.get(p.name) ?? [];
    list.push(p);
    g.rowMap.set(p.name, list);
  }

  const out: ModelGroup[] = [];
  for (const g of groups.values()) {
    const rows: ModelRow[] = [];
    for (const [name, list] of g.rowMap) {
      const base = list.find((x) => !x.variant);
      const variants = list.filter((x) => x.variant);
      // единственный «вариант» без базы (например только o3-mini-high) — показываем как есть
      if (!base && variants.length === 1) {
        rows.push({ key: variants[0].id, name: variants[0].short, primary: variants[0], variants: [], all: list });
        continue;
      }
      const primary = base ?? variants[0];
      rows.push({ key: primary.id, name, primary, variants, all: list });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    out.push({ key: g.key, label: g.label, providerKey: g.providerKey, rows });
  }
  out.sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a.providerKey);
    const ib = GROUP_ORDER.indexOf(b.providerKey);
    return ia - ib || a.label.localeCompare(b.label);
  });
  return out;
}

const RECENT_KEY = "station-llm.recent-models";

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function pushRecent(id: string): void {
  try {
    const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* localStorage недоступен — не критично */
  }
}
