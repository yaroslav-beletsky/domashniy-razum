import { config, litellmApiKey } from "./config";

export interface LiteLLMModel {
  id: string;
  object?: string;
  owned_by?: string;
}

export interface LiteLLMStatus {
  online: boolean;
  ms: number;
  modelCount: number;
  error?: string;
}

export async function listModels(timeoutMs = 6000): Promise<{ ok: boolean; models: LiteLLMModel[]; error?: string }> {
  try {
    const res = await fetch(`${config.litellmBaseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${litellmApiKey()}` },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
    const json = (await res.json()) as { data?: { id: string; object?: string; owned_by?: string }[] };
    const models = (Array.isArray(json.data) ? json.data : []).map((m) => ({
      id: m.id,
      object: m.object,
      owned_by: m.owned_by,
    }));
    models.sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], error: e instanceof Error ? e.message.slice(0, 160) : "unknown error" };
  }
}

/** Пинг LiteLLM: GET /v1/models с таймаутом. Ошибки обрезаем, никаких заголовков/ключей. */
export async function litellmStatus(timeoutMs = 5000): Promise<LiteLLMStatus> {
  const started = Date.now();
  try {
    const res = await fetch(`${config.litellmBaseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${litellmApiKey()}` },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      return { online: false, ms, modelCount: 0, error: `HTTP ${res.status}` };
    }
    const json = (await res.json()) as { data?: { id: string; owned_by?: string }[] };
    const models = Array.isArray(json.data) ? json.data : [];
    return { online: true, ms, modelCount: models.length };
  } catch (e) {
    return {
      online: false,
      ms: Date.now() - started,
      modelCount: 0,
      error: e instanceof Error ? e.message.slice(0, 200) : "unknown error",
    };
  }
}

export interface ChatTestResult {
  ok: boolean;
  ms: number;
  content: string;
  chars: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Превышен лимит ответа навыка Яндекс Диалогов ~4.5 с. */
  overDialogsTimeLimit: boolean;
  error?: string;
  httpStatus?: number;
}

/** Тест модели: один промпт → /v1/chat/completions, замер latency. */
export async function chatTest(model: string, prompt: string, timeoutMs = 30000): Promise<ChatTestResult> {
  const started = Date.now();
  try {
    const res = await fetch(`${config.litellmBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${litellmApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        stream: false,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    const overDialogsTimeLimit = ms > 4500;
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const errJson = await res.json();
        const msg = (errJson?.error?.message ?? errJson?.detail ?? "") as string;
        if (msg) detail += `: ${String(msg).slice(0, 160)}`;
      } catch {
        // тело ошибки не JSON — оставляем статус
      }
      return { ok: false, ms, content: "", chars: 0, overDialogsTimeLimit, error: detail, httpStatus: res.status };
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    return {
      ok: true,
      ms,
      content,
      chars: content.length,
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
      overDialogsTimeLimit,
    };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      content: "",
      chars: 0,
      overDialogsTimeLimit: Date.now() - started > 4500,
      error: e instanceof Error ? e.message.slice(0, 200) : "unknown error",
    };
  }
}
