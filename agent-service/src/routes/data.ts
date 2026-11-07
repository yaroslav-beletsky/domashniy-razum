import { Router, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { config } from "../config.js";
import { db, audit } from "../db.js";
import { requireStation, type AuthedStation } from "../auth.js";
import { runAgent } from "../loop/runner.js";
import type { AgentRow } from "../db.js";
import type { ChatMessage } from "../llm/litellm.js";

export const dataRouter = Router();

const qAgentBySlug = db.prepare("SELECT * FROM agents WHERE slug = ?");

dataRouter.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "agent-service",
    uptime_s: Math.round(process.uptime()),
    litellm: config.litellmBaseUrl,
  });
});

dataRouter.get("/v1/models", requireStation, async (_req, res) => {
  try {
    const r = await fetch(`${config.litellmBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.litellmApiKey}` },
    });
    const data: any = await r.json().catch(() => ({}));
    const agents = db.prepare("SELECT slug FROM agents ORDER BY id").all() as { slug: string }[];
    const list = [
      ...(Array.isArray(data.data) ? data.data : []),
      ...agents.map((a) => ({ id: `agent:${a.slug}`, object: "model", created: 0, owned_by: "agent-service" })),
    ];
    res.json({ object: "list", data: list });
  } catch (e) {
    res.status(502).json({ error: { message: `models upstream: ${String(e).slice(0, 200)}`, type: "upstream_error" } });
  }
});

async function proxyToLiteLLM(req: Request, res: Response) {
  const body = { ...req.body, stream: !!req.body?.stream };
  const t0 = Date.now();
  try {
    const r = await fetch(`${config.litellmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.litellmApiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => "");
      res.status(r.status).json({ error: { message: text.slice(0, 500), type: "upstream_error" } });
      return;
    }
    res.status(r.status);
    res.setHeader("Content-Type", r.headers.get("content-type") ?? "application/json");
    Readable.fromWeb(r.body as any).pipe(res);
    res.on("finish", () => {
      audit("proxy", { ms: Date.now() - t0, stream: body.stream });
    });
  } catch (e) {
    res.status(502).json({ error: { message: String(e).slice(0, 300), type: "upstream_error" } });
  }
}

dataRouter.post("/v1/chat/completions", requireStation, async (req, res) => {
  const model: string = req.body?.model ?? "";
  const authed = (req as any).authedStation as AuthedStation;

  if (!model.startsWith("agent:")) {
    // Transparent proxy: panel/bridge model choice keeps working unchanged
    return proxyToLiteLLM(req, res);
  }

  const slug = model.slice("agent:".length);
  const agent = qAgentBySlug.get(slug) as AgentRow | undefined;
  if (!agent) {
    res.status(404).json({ error: { message: `agent not found: ${slug}`, type: "not_found" } });
    return;
  }
  if (!authed.agent || authed.agent.id !== agent.id) {
    res.status(403).json({
      error: { message: `station is bound to another agent (or none)`, type: "forbidden" },
    });
    return;
  }

  const messages = (req.body?.messages ?? []) as ChatMessage[];
  const wantStream = !!req.body?.stream;

  const result = await runAgent({
    agent,
    station: authed.station,
    messages,
  });

  const id = `chatcmpl-${Date.now().toString(36)}`;
  if (wantStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const send = (chunk: any) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    send({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: result.content }, finish_reason: null }],
    });
    send({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    res.json({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: result.content }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      agent_meta: {
        ms_total: result.msTotal,
        rounds: result.rounds,
        fallback_used: result.fallbackUsed,
        overhead_ms: result.overheadMs,
        finish: result.finish,
      },
    });
  }
});
