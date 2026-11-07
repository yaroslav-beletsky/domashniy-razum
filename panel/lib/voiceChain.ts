// Клиент голосовой цепочки (HTTP): /api/health, /api/stt, /api/tts, /api/ask.
// База — VOICE_CHAIN_URL, по умолчанию http://192.168.88.23:10702.
// Все функции не бросают наружу: offline — штатный ответ панели.
import { config } from "./config";

export interface VoiceHealth {
  ok: boolean;
  ms: number;
  baseUrl: string;
  sttEngine?: string;
  sttModel?: string;
  ttsEngine?: string;
  ttsVoice?: string;
  belchReachable?: boolean;
  error?: string;
}

export async function voiceChainHealth(timeoutMs = 4000): Promise<VoiceHealth> {
  const started = Date.now();
  try {
    const res = await fetch(`${config.voiceChainUrl}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, ms, baseUrl: config.voiceChainUrl, error: `HTTP ${res.status}` };
    const j = (await res.json()) as Record<string, unknown>;
    return {
      ok: true,
      ms,
      baseUrl: config.voiceChainUrl,
      sttEngine: str(j.stt_engine),
      sttModel: str(j.stt_model),
      ttsEngine: str(j.tts_engine),
      ttsVoice: str(j.tts_voice),
      belchReachable: typeof j.belch_reachable === "boolean" ? j.belch_reachable : undefined,
    };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      baseUrl: config.voiceChainUrl,
      error: e instanceof Error ? e.message.slice(0, 160) : "unreachable",
    };
  }
}

export interface SttOutcome {
  ok: boolean;
  ms: number;
  text?: string;
  language?: string;
  confidence?: number;
  durationMs?: number;
  error?: string;
  httpStatus?: number;
}

/** WAV (любой PCM, сервис сам ресемплит) → текст. Поле формы — audio. */
export async function voiceChainStt(wav: Buffer, timeoutMs = config.voiceChainTimeoutMs): Promise<SttOutcome> {
  const started = Date.now();
  try {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");
    const res = await fetch(`${config.voiceChainUrl}/api/stt`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, ms, error: str(j.error) ?? `HTTP ${res.status}`, httpStatus: res.status };
    }
    return {
      ok: true,
      ms,
      text: str(j.text) ?? "",
      language: str(j.language),
      confidence: typeof j.confidence === "number" ? j.confidence : undefined,
      durationMs: typeof j.duration_ms === "number" ? j.duration_ms : undefined,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message.slice(0, 200) : "unreachable" };
  }
}

export interface TtsOutcome {
  ok: boolean;
  ms: number;
  wav?: Buffer;
  error?: string;
  httpStatus?: number;
}

/** Текст → WAV 22050 Гц. */
export async function voiceChainTts(text: string, timeoutMs = 30000): Promise<TtsOutcome> {
  const started = Date.now();
  try {
    const res = await fetch(`${config.voiceChainUrl}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: false, ms, error: str(j.error) ?? `HTTP ${res.status}`, httpStatus: res.status };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, ms, wav: buf };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message.slice(0, 200) : "unreachable" };
  }
}

export interface AskOutcome {
  ok: boolean;
  ms: number;
  replyWav?: Buffer;
  replyText?: string;
  sttText?: string;
  sttMs?: number;
  llmMs?: number;
  ttsMs?: number;
  error?: string;
  httpStatus?: number;
}

/** Полный круг: аудио → STT → LLM → TTS → аудио. Ответ — wav; метаданные в JSON-полях. */
export async function voiceChainAsk(wav: Buffer, timeoutMs = config.voiceChainTimeoutMs): Promise<AskOutcome> {
  const started = Date.now();
  try {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");
    const res = await fetch(`${config.voiceChainUrl}/api/ask`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    const ctype = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      const j = ctype.includes("json") ? ((await res.json().catch(() => ({}))) as Record<string, unknown>) : {};
      return {
        ok: false,
        ms,
        sttText: str(j.stt_text),
        sttMs: num(j.stt_ms),
        error: str(j.error) ?? `HTTP ${res.status}`,
        httpStatus: res.status,
      };
    }
    if (ctype.includes("json")) {
      // Формат voice-chain: {text, response, stt_ms, tts_ms, total_ms, audio_url}
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const out: AskOutcome = {
        ok: true,
        ms,
        sttText: str(j.text),
        replyText: str(j.response) ?? str(j.reply),
        sttMs: num(j.stt_ms),
        ttsMs: num(j.tts_ms),
        llmMs: num(j.llm_ms) ?? derivedLlm(j),
      };
      const audioUrl = str(j.audio_url);
      if (audioUrl && audioUrl.startsWith("/")) {
        try {
          const ar = await fetch(`${config.voiceChainUrl}${audioUrl}`, { signal: AbortSignal.timeout(20000) });
          if (ar.ok) out.replyWav = Buffer.from(await ar.arrayBuffer());
        } catch {
          /* аудио недоступно — вернём текст */
        }
      }
      return out;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, ms, replyWav: buf };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message.slice(0, 200) : "unreachable" };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function derivedLlm(j: Record<string, unknown>): number | undefined {
  const t = num(j.total_ms), a = num(j.stt_ms), c = num(j.tts_ms);
  return t !== undefined && a !== undefined && c !== undefined ? Math.max(0, t - a - c) : undefined;
}
