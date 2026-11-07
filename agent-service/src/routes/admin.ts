import { Router } from "express";
import { db, audit, deleteSession, type AgentRow, type McpServerRow, type StationRow } from "../db.js";
import { requireAdmin, generateStationKey, hashStationKey } from "../auth.js";
import { setSecret, secretNamesOnly, listSecretNames } from "../secrets.js";
import { refreshServer, cachedTools, getServer, listServers } from "../mcp/pool.js";
import { runAgent } from "../loop/runner.js";

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const AGENT_FIELDS = [
  "slug", "system_prompt", "model", "fallback_model", "tools_enabled",
  "max_rounds", "budget_ms", "max_tokens", "memory_turns", "memory_ttl_s",
] as const;

function parseAgentBody(body: any, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of AGENT_FIELDS) {
    if (body[f] === undefined) {
      if (!partial && (f === "slug" || f === "model")) throw new Error(`missing field: ${f}`);
      continue;
    }
    if (f === "slug" && !/^[a-z0-9][a-z0-9_-]{1,60}$/.test(body[f])) throw new Error("bad slug");
    if (f === "tools_enabled") {
      const v = body[f];
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error("tools_enabled must be string[]");
      out[f] = JSON.stringify(v);
    } else if (["max_rounds", "budget_ms", "max_tokens", "memory_turns", "memory_ttl_s"].includes(f)) {
      out[f] = Math.max(1, Math.min(100000, Number(body[f])));
    } else {
      out[f] = String(body[f]);
    }
  }
  return out;
}

// ---------- agents ----------
adminRouter.get("/agents", (_req, res) => {
  const agents = db.prepare("SELECT * FROM agents ORDER BY id").all() as AgentRow[];
  const stations = db.prepare("SELECT agent_id, COUNT(*) c FROM stations GROUP BY agent_id").all() as { agent_id: number; c: number }[];
  const bound = new Map(stations.map((s) => [s.agent_id, s.c]));
  res.json(agents.map((a) => ({ ...a, tools_enabled: JSON.parse(a.tools_enabled), stations_bound: bound.get(a.id) ?? 0 })));
});

adminRouter.post("/agents", (req, res) => {
  try {
    const fields = parseAgentBody(req.body ?? {}, false);
    const t = Date.now();
    const r = db.prepare(
      `INSERT INTO agents (slug, system_prompt, model, fallback_model, tools_enabled, max_rounds, budget_ms, max_tokens, memory_turns, memory_ttl_s, version, created_at, updated_at)
       VALUES (@slug, @system_prompt, @model, @fallback_model, @tools_enabled, @max_rounds, @budget_ms, @max_tokens, @memory_turns, @memory_ttl_s, 1, ${t}, ${t})`
    ).run({
      system_prompt: "",
      fallback_model: null,
      tools_enabled: "[]",
      max_rounds: 3,
      budget_ms: 6000,
      max_tokens: 250,
      memory_turns: 6,
      memory_ttl_s: 300,
      ...fields,
    });
    audit("admin.agent.create", { id: r.lastInsertRowid, slug: fields.slug });
    res.status(201).json(db.prepare("SELECT * FROM agents WHERE id = ?").get(r.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: { message: String(e).slice(0, 300), type: "bad_request" } });
  }
});

function loadAgent(req: any): AgentRow | undefined {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(Number(req.params.id)) as AgentRow | undefined;
}

adminRouter.get("/agents/:id", (req, res) => {
  const a = loadAgent(req);
  if (!a) return res.status(404).json({ error: { message: "not found", type: "not_found" } });
  res.json({ ...a, tools_enabled: JSON.parse(a.tools_enabled) });
});

adminRouter.patch("/agents/:id", (req, res) => {
  const a = loadAgent(req);
  if (!a) return res.status(404).json({ error: { message: "not found", type: "not_found" } });
  const ifMatch = req.headers["if-match"];
  if (ifMatch !== undefined && Number(ifMatch) !== a.version) {
    return res.status(409).json({ error: { message: `version mismatch: have ${a.version}`, type: "conflict", version: a.version } });
  }
  try {
    const fields = parseAgentBody(req.body ?? {}, true);
    if (Object.keys(fields).length === 0) throw new Error("no fields to update");
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(", ");
    db.prepare(`UPDATE agents SET ${sets}, version = version + 1, updated_at = ${Date.now()} WHERE id = @id`)
      .run({ ...fields, id: a.id });
    audit("admin.agent.patch", { id: a.id, fields: Object.keys(fields) });
    res.json(db.prepare("SELECT * FROM agents WHERE id = ?").get(a.id));
  } catch (e) {
    res.status(400).json({ error: { message: String(e).slice(0, 300), type: "bad_request" } });
  }
});

adminRouter.delete("/agents/:id", (req, res) => {
  const a = loadAgent(req);
  if (!a) return res.status(404).json({ error: { message: "not found", type: "not_found" } });
  db.prepare("UPDATE stations SET agent_id = NULL WHERE agent_id = ?").run(a.id);
  db.prepare("DELETE FROM agents WHERE id = ?").run(a.id);
  audit("admin.agent.delete", { id: a.id, slug: a.slug });
  res.json({ deleted: a.id });
});

// ---------- agent test (SSE) ----------
adminRouter.post("/agents/:id/test", async (req, res) => {
  const a = loadAgent(req);
  if (!a) return res.status(404).json({ error: { message: "not found", type: "not_found" } });

  // Необязательный контекст колонки: подставит {{room}}/{{station_name}} как для
  // реального запроса с колонки (и то же время/дату). Не задан/null — «без колонки».
  let station: StationRow | null = null;
  if (req.body?.station_id !== undefined && req.body?.station_id !== null) {
    const sid = Number(req.body?.station_id);
    station = (db.prepare("SELECT * FROM stations WHERE id = ?").get(sid) as StationRow | undefined) ?? null;
    if (!station) {
      return res.status(400).json({ error: { message: `station not found: ${req.body?.station_id}`, type: "bad_request" } });
    }
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const prompt = String(req.body?.prompt ?? "Сколько сейчас времени?");
  const t0 = Date.now();
  try {
    const result = await runAgent({
      agent: a,
      station,
      messages: [{ role: "user", content: prompt }],
      sessionKey: `test:${a.id}:${Date.now()}`,
      voice: req.body?.voice !== false,
      events: {
        onRound: (n) => send("round", { n }),
        onToolCall: (e) => send("tool_call", e),
        onDelta: (text) => send("delta", { text }),
        onFallback: (from, to) => send("fallback", { from, to }),
      },
    });
    send("done", {
      ms_total: result.msTotal,
      rounds: result.rounds,
      fallback_used: result.fallbackUsed,
      overhead_ms: result.overheadMs,
      finish: result.finish,
      chars: result.content.length,
      elapsed_ms: Date.now() - t0,
    });
  } catch (e) {
    send("error", { message: String(e).slice(0, 300) });
  }
  res.end();
});

// ---------- MCP servers ----------
function parseMcpBody(body: any, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const name = body.name;
  if (name !== undefined) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{1,40}$/.test(name)) throw new Error("bad name (used as tool prefix)");
    out.name = name;
  } else if (!partial) throw new Error("missing field: name");
  const transport = body.transport;
  if (transport !== undefined) {
    if (!["http", "sse", "stdio"].includes(transport)) throw new Error("transport must be http|sse|stdio");
    out.transport = transport;
  } else if (!partial) throw new Error("missing field: transport");
  if (body.url !== undefined) out.url = body.url ? String(body.url) : null;
  if (body.cmd !== undefined) out.cmd = body.cmd ? String(body.cmd) : null;
  if (body.secret_refs !== undefined) {
    if (!Array.isArray(body.secret_refs) || body.secret_refs.some((x: unknown) => typeof x !== "string"))
      throw new Error("secret_refs must be string[]");
    out.secret_refs = JSON.stringify(body.secret_refs);
  }
  if (body.enabled !== undefined) out.enabled = body.enabled ? 1 : 0;
  if (body.timeout_ms !== undefined) out.timeout_ms = Math.max(200, Math.min(30000, Number(body.timeout_ms)));
  return out;
}

adminRouter.get("/mcp", (_req, res) => {
  res.json(listServers().map((s: McpServerRow) => ({
    ...s,
    secret_refs: JSON.parse(s.secret_refs),
    tools: s.tools_cache ? cachedTools(s).length : 0,
  })));
});

adminRouter.post("/mcp", (req, res) => {
  try {
    const fields = parseMcpBody(req.body ?? {}, false);
    const r = db.prepare(
      `INSERT INTO mcp_servers (name, transport, url, cmd, secret_refs, enabled, timeout_ms, status)
       VALUES (@name, @transport, @url, @cmd, @secret_refs, @enabled, @timeout_ms, 'unknown')`
    ).run({ url: null, cmd: null, secret_refs: "[]", enabled: 1, timeout_ms: 2500, ...fields });
    audit("admin.mcp.create", { id: r.lastInsertRowid, name: fields.name });
    res.status(201).json(getServer(Number(r.lastInsertRowid)));
  } catch (e) {
    res.status(400).json({ error: { message: String(e).slice(0, 300), type: "bad_request" } });
  }
});

adminRouter.patch("/mcp/:id", (req, res) => {
  const s = getServer(Number(req.params.id));
  if (!s) return res.status(404).json({ error: { message: "not found", type: "not_found" } });
  try {
    const fields = parseMcpBody(req.body ?? {}, true);
    if (Object.keys(fields).length === 0) throw new Error("no fields");
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(", ");
    db.prepare(`UPDATE mcp_servers SET ${sets} WHERE id = @id`).run({ ...fields, id: s.id });
    res.json(getServer(s.id));
  } catch (e) {
    res.status(400).json({ error: { message: String(e).slice(0, 300), type: "bad_request" } });
  }
});

adminRouter.delete("/mcp/:id", (req, res) => {
  const s = getServer(Number(req.params.id));
  if (!s) return res.status(404).json({ error: { message: "not found", type: "not_found" } });
  db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(s.id);
  audit("admin.mcp.delete", { id: s.id, name: s.name });
  res.json({ deleted: s.id });
});

adminRouter.post("/mcp/:id/refresh", async (req, res) => {
  try {
    const tools = await refreshServer(Number(req.params.id));
    res.json({ status: "ok", tools: tools.length });
  } catch (e) {
    res.status(502).json({ error: { message: String(e).slice(0, 300), type: "mcp_error" } });
  }
});

adminRouter.get("/mcp/:id/tools", (req, res) => {
  const s = getServer(Number(req.params.id));
  if (!s) return res.status(404).json({ error: { message: "not found", type: "not_found" } });
  res.json({ server: s.name, status: s.status, tools: cachedTools(s) });
});

adminRouter.put("/mcp/:id/secrets", (req, res) => {
  const s = getServer(Number(req.params.id));
  if (!s) return res.status(404).json({ error: { message: "not found", type: "not_found" } });
  const entries = req.body?.secrets;
  if (!Array.isArray(entries)) return res.status(400).json({ error: { message: "body: {secrets:[{name,value}]}", type: "bad_request" } });
  try {
    for (const e of entries) {
      if (!e || typeof e.name !== "string" || typeof e.value !== "string") throw new Error("each secret needs name+value");
      setSecret(e.name, e.value);
    }
  } catch (err) {
    return res.status(400).json({ error: { message: String(err).slice(0, 300), type: "bad_request" } });
  }
  audit("admin.mcp.secrets", { id: s.id, names: entries.map((e: any) => e.name) });
  const refs = JSON.parse(s.secret_refs) as string[];
  res.json({ secrets: secretNamesOnly(refs.length ? refs : listSecretNames()) });
});

adminRouter.get("/mcp/:id/secrets", (req, res) => {
  const s = getServer(Number(req.params.id));
  if (!s) return res.status(404).json({ error: { message: "not found", type: "not_found" } });
  res.json({ secrets: secretNamesOnly(JSON.parse(s.secret_refs)) });
});

// ---------- stations ----------
/** Человекочитаемая метка колонки (name/room): без управляющих символов, ≤60 симв. */
function cleanStationLabel(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  const s = String(v ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60);
  return s || null; // пустая строка очищает значение (NULL в БД)
}

adminRouter.get("/stations", (_req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.device, s.agent_id, s.name, s.room, s.created_at,
           a.slug AS agent_slug, s.key_hash IS NOT NULL AS has_key
    FROM stations s LEFT JOIN agents a ON a.id = s.agent_id ORDER BY s.id
  `).all() as any[];
  res.json(rows);
});

adminRouter.post("/stations", (req, res) => {
  const device = String(req.body?.device ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,60}$/.test(device)) {
    return res.status(400).json({ error: { message: "bad device id", type: "bad_request" } });
  }
  const name = cleanStationLabel(req.body?.name);
  const room = cleanStationLabel(req.body?.room);
  try {
    const t = Date.now();
    const r = db.prepare("INSERT INTO stations (device, agent_id, name, room, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run(device, req.body?.agent_id ? Number(req.body.agent_id) : null, name ?? null, room ?? null, t, t);
    audit("admin.station.create", { id: r.lastInsertRowid, device });
    res.status(201).json(db.prepare("SELECT id, device, agent_id, name, room, created_at FROM stations WHERE id = ?").get(r.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: { message: String(e).slice(0, 300), type: "bad_request" } });
  }
});

// Имя/комната колонки — источник чипов {{station_name}} / {{room}} в промпте агента.
adminRouter.patch("/stations/:id", (req, res) => {
  const s = loadStation(req);
  if (!s) return res.status(404).json({ error: { message: "not found", type: "not_found" } });
  const name = cleanStationLabel(req.body?.name);
  const room = cleanStationLabel(req.body?.room);
  if (name === undefined && room === undefined) {
    return res.status(400).json({ error: { message: "fields: name, room", type: "bad_request" } });
  }
  const sets: string[] = [];
  const params: Record<string, unknown> = { id: s.id, updated: Date.now() };
  if (name !== undefined) { sets.push("name = @name"); params.name = name; } // "" или null → очищает
  if (room !== undefined) { sets.push("room = @room"); params.room = room; }
  db.prepare(`UPDATE stations SET ${sets.join(", ")}, updated_at = @updated WHERE id = @id`).run(params);
  audit("admin.station.patch", { id: s.id, fields: [name !== undefined && "name", room !== undefined && "room"].filter(Boolean) });
  res.json({ station: s.id, device: s.device, name: name ?? s.name, room: room ?? s.room });
});

function loadStation(req: any): StationRow | undefined {
  return db.prepare("SELECT * FROM stations WHERE id = ?").get(Number(req.params.id)) as StationRow | undefined;
}

adminRouter.get("/stations/:id/agent", (req, res) => {
  const s = loadStation(req);
  if (!s) return res.status(404).json({ error: { message: "not found", type: "not_found" } });
  const agent = s.agent_id ? db.prepare("SELECT id, slug, model FROM agents WHERE id = ?").get(s.agent_id) : null;
  res.json({ station: s.id, device: s.device, name: s.name, room: s.room, agent });
});

adminRouter.put("/stations/:id/agent", (req, res) => {
  const s = loadStation(req);
  if (!s) return res.status(404).json({ error: { message: "not found", type: "not_found" } });
  const agentId = req.body?.agent_id === null ? null : Number(req.body?.agent_id);
  if (agentId !== null && !db.prepare("SELECT id FROM agents WHERE id = ?").get(agentId)) {
    return res.status(404).json({ error: { message: "agent not found", type: "not_found" } });
  }
  db.prepare("UPDATE stations SET agent_id = ?, updated_at = ? WHERE id = ?").run(agentId, Date.now(), s.id);
  audit("admin.station.bind", { id: s.id, agent_id: agentId });
  res.json({ station: s.id, agent_id: agentId });
});

adminRouter.post("/stations/:id/key", (req, res) => {
  const s = loadStation(req);
  if (!s) return res.status(404).json({ error: { message: "not found", type: "not_found" } });
  const key = generateStationKey(s.device);
  db.prepare("UPDATE stations SET key_hash = ?, updated_at = ? WHERE id = ?")
    .run(hashStationKey(key), Date.now(), s.id);
  audit("admin.station.key", { id: s.id });
  res.json({ key, note: "shown once" });
});

// Отзыв ключа колонки: key_hash → NULL, прежний sk-station-* перестаёт проходить авторизацию. Идемпотентно.
adminRouter.delete("/stations/:id/key", (req, res) => {
  const s = loadStation(req);
  if (!s) return res.status(404).json({ error: { message: "not found", type: "not_found" } });
  const had = s.key_hash !== null;
  db.prepare("UPDATE stations SET key_hash = NULL, updated_at = ? WHERE id = ?").run(Date.now(), s.id);
  audit("admin.station.key.revoke", { id: s.id, had_key: had });
  res.json({ ok: true, station: s.id, revoked: had });
});

// ---------- sessions ----------
adminRouter.delete("/sessions/:station", (req, res) => {
  const ok = deleteSession(req.params.station);
  res.json({ station: req.params.station, deleted: ok });
});

// ---------- audit ----------
adminRouter.get("/audit", (req, res) => {
  const limit = Math.min(200, Number(req.query.limit ?? 50));
  const rows = db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit);
  res.json(rows);
});
