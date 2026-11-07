import { chat, chatStream, LlmError, type ChatMessage, type ChatResult } from "../llm/litellm.js";
import { voiceSystemPrompt, voiceClean } from "./voice.js";
import { chipValues, renderChips } from "./chips.js";
import { collectTools, type AgentToolSpec } from "../mcp/registry.js";
import { compressRound, dedupKey } from "../mcp/tools.js";
import { audit, getSession, setSession, type AgentRow, type StationRow } from "../db.js";

export interface RunEvents {
  onRound?: (n: number) => void;
  onToolCall?: (e: { name: string; ms: number; ok: boolean }) => void;
  onDelta?: (text: string) => void;
  onFallback?: (from: string, to: string) => void;
}

export interface RunResult {
  content: string;
  msTotal: number;
  rounds: number;
  fallbackUsed: boolean;
  overheadMs: number;
  finish: "answer" | "budget" | "error";
}

const FALLBACK_TEXT = "Сейчас не смог ответить, попробуй ещё раз чуть позже.";

/**
 * Agent tool loop.
 *  - ≤ max_rounds rounds; tool calls within a round run in parallel
 *  - tool timeout = min(2500, remaining − 1500)
 *  - tool output compressed: 1500 chars/call, 4000/round
 *  - last round: tool_choice "none"
 *  - dedup of identical (tool, args)
 *  - budget exhausted -> final call without tools
 *  - LLM failure -> fallback_model -> final without tools
 */
export async function runAgent(opts: {
  agent: AgentRow;
  station: StationRow | null;
  messages: ChatMessage[];
  events?: RunEvents;
  sessionKey?: string;
  voice?: boolean; // default true: voice-clean output
}): Promise<RunResult> {
  const { agent, station, events = {} } = opts;
  const doVoice = opts.voice !== false;
  const t0 = Date.now();
  const budget = agent.budget_ms;
  let rounds = 0;
  let fallbackUsed = false;
  let overheadMs = 0;

  const sessionKey = opts.sessionKey ?? (station ? `station:${station.device}` : null);
  const session = sessionKey ? getSession(sessionKey) : {};
  const seenTools: Set<string> = new Set(
    (Array.isArray(session.seenTools) ? session.seenTools : []).map(String)
  );

  const incomingSystem = opts.messages.find((m) => m.role === "system");
  // Чипы {{time}}/{{date}}/{{room}}/{{station_name}}: значения фиксируются на старте
  // запроса и не пересчитываются — все раунды tool-loop и фолбэк видят один промпт.
  let system = voiceSystemPrompt(renderChips(agent.system_prompt, chipValues({ station })));
  if (incomingSystem?.content && incomingSystem.content !== system) {
    system += `\n\n[контекст моста]\n${incomingSystem.content}`;
  }

  // History: keep last memory_turns*2+1 messages, non-system
  const hist = opts.messages.filter((m) => m.role !== "system").slice(-(agent.memory_turns * 2 + 1));
  const conv: ChatMessage[] = [{ role: "system", content: system }, ...hist];

  const remaining = () => budget - (Date.now() - t0);
  const tools: AgentToolSpec[] = await collectTools(agent);
  overheadMs = Date.now() - t0;

  async function doCall(model: string, useTools: boolean, streamFinal: boolean, maxTokens: number = agent.max_tokens) {
    const base = {
      model,
      messages: conv,
      temperature: 0,
      max_tokens: maxTokens,
    };
    if (!useTools || tools.length === 0) {
      return streamFinal
        ? chatStream(base, (d) => events.onDelta?.(d))
        : chat(base);
    }
    const spec = { ...base, tools: tools.map((t) => ({ type: "function", function: t.function })) };
    return streamFinal ? chatStream(spec, (d) => events.onDelta?.(d)) : chat(spec);
  }

  async function callLlm(primary: string, useTools: boolean, streamFinal: boolean) {
    try {
      return await doCall(primary, useTools, streamFinal);
    } catch (e) {
      if (agent.fallback_model && !fallbackUsed) {
        fallbackUsed = true;
        events.onFallback?.(primary, agent.fallback_model);
        audit("llm.fallback", {
          from: primary,
          to: agent.fallback_model,
          error: String(e).slice(0, 200),
        }, station?.id, agent.id);
        return doCall(agent.fallback_model, useTools, streamFinal);
      }
      throw e;
    }
  }

  // Защита от тишины: «думающие» модели при temperature=0 тратят max_tokens на reasoning и отдают пустой content
  // (finish=length). Пустой ответ без вызовов инструментов — неуспех: один повтор той же моделью (с увеличенным
  // лимитом токенов — на прежнем лимите результат детерминированно тот же), затем запасная модель.
  const cleanOf = (t: string) => (doVoice ? voiceClean(t) : t.trim());
  const isEmpty = (r: ChatResult) => r.toolCalls.length === 0 && cleanOf(r.content) === "";
  const boosted = Math.min(Math.max(agent.max_tokens * 2, 600), 2000);

  async function tryCall(model: string, useTools: boolean, streamFinal: boolean): Promise<ChatResult | null> {
    try {
      return await doCall(model, useTools, streamFinal, boosted);
    } catch {
      return null; // ошибка повтора = тоже неуспех, идём дальше по цепочке
    }
  }

  async function callGuarded(useTools: boolean, streamFinal: boolean): Promise<ChatResult> {
    const fbBefore = fallbackUsed;
    const first = await callLlm(agent.model, useTools, streamFinal);
    if (!isEmpty(first)) return first;
    // callLlm мог сам уйти на запасную из-за ошибки — тогда пустой ответ пришёл от неё
    const fromFallback = !fbBefore && fallbackUsed;
    const model = fromFallback ? (agent.fallback_model as string) : agent.model;
    audit("llm.empty", { model, stage: "first" }, station?.id, agent.id);

    const second = await tryCall(model, useTools, streamFinal);
    if (second && !isEmpty(second)) return second;
    audit("llm.empty", { model, stage: "retry" }, station?.id, agent.id);

    if (!fromFallback && agent.fallback_model) {
      if (!fbBefore) events.onFallback?.(model, agent.fallback_model);
      fallbackUsed = true;
      const third = await tryCall(agent.fallback_model, useTools, streamFinal);
      if (third && !isEmpty(third)) return third;
      audit("llm.empty", { model: agent.fallback_model, stage: "fallback" }, station?.id, agent.id);
      return third ?? second ?? first;
    }
    return second ?? first;
  }

  let finish: RunResult["finish"] = "answer";
  let content = "";

  try {
    if (tools.length === 0) {
      // Fast path: single LLM call, no tools
      const r = await callGuarded(false, true);
      content = r.content;
    } else {
      let answered = false;
      for (let round = 1; round <= agent.max_rounds && !answered; round++) {
        if (remaining() < 1200) {
          finish = "budget";
          break;
        }
        rounds = round;
        events.onRound?.(round);
        const isLast = round === agent.max_rounds;
        const res = await callGuarded(!isLast, false);

        if (!res.toolCalls.length) {
          content = res.content;
          answered = true;
          break;
        }

        // Deduplicate + execute in parallel
        const calls = res.toolCalls.filter((tc) => {
          let args: unknown = {};
          try {
            args = JSON.parse(tc.arguments || "{}");
          } catch {
            /* keep raw */
          }
          const key = dedupKey(tc.name, args);
          if (seenTools.has(key)) return false;
          seenTools.add(key);
          return true;
        });

        conv.push({
          role: "assistant",
          content: res.content || null,
          tool_calls: res.toolCalls.map((tc, i) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
            _i: i,
          })),
        });

        if (calls.length === 0) {
          // model kept re-calling the same tool: force final answer
          finish = "budget";
          break;
        }

        const toolTimeout = Math.min(2500, Math.max(300, remaining() - 1500));
        const results = await Promise.all(
          calls.map(async (tc) => {
            let args: unknown = {};
            try {
              args = JSON.parse(tc.arguments || "{}");
            } catch {
              args = { _raw: tc.arguments };
            }
            const spec = tools.find((t) => t.function.name === tc.name);
            const started = Date.now();
            let out;
            if (!spec) {
              out = { ok: false, ms: 0, text: `tool ${tc.name} unavailable` };
            } else {
              try {
                out = await spec.call(args, toolTimeout);
              } catch (e) {
                out = { ok: false, ms: Date.now() - started, text: String(e).slice(0, 200) };
              }
            }
            events.onToolCall?.({ name: tc.name, ms: out.ms, ok: out.ok });
            audit("tool.call", { tool: tc.name, ms: out.ms, ok: out.ok }, station?.id, agent.id);
            return { tc, text: out.ok ? out.text : `Ошибка инструмента: ${out.text}` };
          })
        );

        const compressed = compressRound(results.map((r) => r.text));
        results.forEach((r, i) => {
          conv.push({ role: "tool", tool_call_id: r.tc.id, content: compressed[i] });
        });
      }

      if (!answered) {
        // budget exhausted or rounds over: final streamed call without tools (with fallback)
        try {
          const final = await callGuarded(false, true);
          content = final.content;
        } catch (e) {
          finish = "error";
          content = FALLBACK_TEXT;
          audit("llm.error", { error: String(e).slice(0, 300) }, station?.id, agent.id);
        }
      }
    }
  } catch (e) {
    finish = "error";
    if (e instanceof LlmError && agent.fallback_model && !fallbackUsed) {
      try {
        fallbackUsed = true;
        events.onFallback?.(agent.model, agent.fallback_model);
        const r = await chat({
          model: agent.fallback_model,
          messages: conv.slice(0, 2),
          temperature: 0,
          max_tokens: agent.max_tokens,
        });
        content = r.content;
        finish = "answer";
      } catch {
        content = FALLBACK_TEXT;
      }
    } else {
      content = FALLBACK_TEXT;
    }
    audit("agent.error", { error: String(e).slice(0, 300) }, station?.id, agent.id);
  }

  // Все попытки (основная, повтор, запасная) дали пустоту — колонка не должна молчать.
  if (cleanOf(content) === "") {
    finish = "error";
    content = FALLBACK_TEXT;
    audit("llm.empty", { stage: "give_up" }, station?.id, agent.id);
  }

  const cleaned = cleanOf(content);
  const msTotal = Date.now() - t0;

  if (sessionKey) {
    setSession(sessionKey, {
      seenTools: [...seenTools].slice(-50),
      lastAgent: agent.id,
      updatedAt: Date.now(),
    });
  }

  audit("agent.run", {
    slug: agent.slug,
    ms: msTotal,
    rounds,
    fallbackUsed,
    overheadMs,
    finish,
    chars: cleaned.length,
  }, station?.id, agent.id);

  return { content: cleaned, msTotal, rounds, fallbackUsed, overheadMs, finish };
}
