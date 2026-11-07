import { config } from "../config.js";

export interface ChatMessage {
  role: string;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface LlmCallOpts {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: string;
  stream?: boolean;
  signal?: AbortSignal;
}

export class LlmError extends Error {
  constructor(
    public status: number,
    public body: string,
    public model: string
  ) {
    super(`LLM ${status} for ${model}: ${body.slice(0, 300)}`);
    this.name = "LlmError";
  }
}

async function rawCall(opts: LlmCallOpts): Promise<Response> {
  const ctrl = opts.signal ? undefined : new AbortController();
  const timer =
    ctrl && setTimeout(() => ctrl.abort(), 55_000);
  try {
    return await fetch(`${config.litellmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.litellmApiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.max_tokens,
        ...(opts.tools?.length ? { tools: opts.tools, tool_choice: opts.tool_choice ?? "auto" } : {}),
        stream: !!opts.stream,
      }),
      signal: opts.signal ?? ctrl?.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function extractContent(data: any): string {
  const msg = data?.choices?.[0]?.message;
  let text = msg?.content ?? "";
  if (Array.isArray(text)) {
    text = text.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("");
  }
  return typeof text === "string" ? text : "";
}

export interface ChatResult {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: any;
  model: string;
}

export async function chat(opts: LlmCallOpts): Promise<ChatResult> {
  const r = await rawCall({ ...opts, stream: false });
  const text = await r.text();
  if (!r.ok) throw new LlmError(r.status, text, opts.model);
  const data = JSON.parse(text);
  const msg = data?.choices?.[0]?.message ?? {};
  const toolCalls = (msg.tool_calls ?? []).map((t: any) => ({
    id: t.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name: t.function?.name ?? "",
    arguments: typeof t.function?.arguments === "string" ? t.function.arguments : JSON.stringify(t.function?.arguments ?? {}),
  }));
  return { content: extractContent(data), toolCalls, usage: data?.usage ?? null, model: data?.model ?? opts.model };
}

/**
 * Streaming chat. Accumulates the full text, reports deltas via onDelta.
 */
export async function chatStream(
  opts: LlmCallOpts,
  onDelta: (delta: string) => void
): Promise<ChatResult> {
  const r = await rawCall({ ...opts, stream: true });
  if (!r.ok) throw new LlmError(r.status, await r.text(), opts.model);
  if (!r.body) throw new LlmError(500, "empty stream", opts.model);

  let content = "";
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: any = null;
  let model = opts.model;
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  const feed = (line: string) => {
    const s = line.trim();
    if (!s.startsWith("data:")) return;
    const payload = s.slice(5).trim();
    if (payload === "[DONE]") return;
    let d: any;
    try {
      d = JSON.parse(payload);
    } catch {
      return;
    }
    if (d.model) model = d.model;
    const delta = d?.choices?.[0]?.delta;
    if (delta?.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const cur = toolCalls.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        toolCalls.set(tc.index, cur);
      }
    }
    if (d.usage) usage = d.usage;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) feed(line);
  }
  if (buf) feed(buf);

  return {
    content,
    toolCalls: [...toolCalls.values()].filter((t) => t.name),
    usage,
    model,
  };
}
