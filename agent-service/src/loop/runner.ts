import { chat, chatStream, LlmError, type ChatMessage } from "../llm/litellm.js";
import { voiceSystemPrompt, voiceClean } from "./voice.js";
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
    Array.isArray(session.seenTools) ? session.seenTools : []
  );

  const incomingSystem = opts.messages.find((m) => m.role === "system");
  let system = voiceSystemPrompt(agent.system_prompt);
  if (incomingSystem?.content && incomingSystem.content !== system) {
    system += `\n\n[контекст моста]\n${incomingSystem.content}`;
  }

  // History: keep last memory_turns*2+1 messages, non-system
  const hist = opts.messages.filter((m) => m.role !== "system").slice(-(agent.memory_turns * 2 + 1));
  const conv: ChatMessage[] = [{ role: "system", content: system }, ...hist];

  const remaining = () => budget - (Date.now() - t0);
  const tools: AgentToolSpec[] = await collectTools(agent);
  overheadMs = Date.now() - t0;

  async function callLlm(model: string, useTools: boolean, streamFinal: boolean) {
    const base = {
      model,
      messages: conv,
      temperature: 0,
      max_tokens: agent.max_tokens,
    };
    if (!useTools || tools.length === 0) {
      return streamFinal
        ? chatStream(base, (d) => events.onDelta?.(d))
        : chat(base);
    }
    const spec = { ...base, tools: tools.map((t) => ({ type: "function", function: t.function })) };
    return streamFinal ? chatStream(spec, (d) => events.onDelta?.(d)) : chat(spec);
  }

  let finish: RunResult["finish"] = "answer";
  let content = "";

  try {
    if (tools.length === 0) {
      // Fast path: single LLM call, no tools
      const r = await callLlm(agent.model, false, true);
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
        let res;
        try {
          res = await callLlm(agent.model, !isLast, false);
        } catch (e) {
          if (!fallbackUsed && agent.fallback_model) {
            fallbackUsed = true;
            events.onFallback?.(agent.model, agent.fallback_model);
            audit("llm.fallback", {
              from: agent.model,
              to: agent.fallback_model,
              error: String(e).slice(0, 200),
            }, station?.id, agent.id);
            res = await callLlm(agent.fallback_model, !isLast, false);
          } else {
            throw e;
          }
        }

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
        // budget exhausted or rounds over: final streamed call without tools
        try {
          const final = await callLlm(fallbackUsed && agent.fallback_model ? agent.fallback_model : agent.model, false, true);
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

  const cleaned = doVoice ? voiceClean(content) : content.trim();
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
