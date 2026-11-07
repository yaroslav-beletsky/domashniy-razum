import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { db, type AgentRow, type StationRow } from "./db.js";

export function hashStationKey(key: string): string {
  return crypto.createHmac("sha256", config.pepper).update(key).digest("hex");
}

export function generateStationKey(device: string): string {
  const rand = crypto.randomBytes(18).toString("hex");
  return `sk-station-${device}-${rand}`;
}

const qStation = db.prepare("SELECT * FROM stations WHERE key_hash = ?");
const qAgent = db.prepare("SELECT * FROM agents WHERE id = ?");

export interface AuthedStation {
  station: StationRow;
  agent: AgentRow | null;
}

export function authStation(req: Request): AuthedStation | null {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(sk-station-[A-Za-z0-9._-]+)$/.exec(h);
  if (!m) return null;
  const station = qStation.get(hashStationKey(m[1])) as StationRow | undefined;
  if (!station) return null;
  const agent = station.agent_id
    ? (qAgent.get(station.agent_id) as AgentRow | undefined)
    : undefined;
  return { station, agent: agent ?? null };
}

export function requireStation(req: Request, res: Response, next: NextFunction) {
  const authed = authStation(req);
  if (!authed) {
    res.status(401).json({ error: { message: "invalid station key", type: "auth_error" } });
    return;
  }
  (req as any).authedStation = authed;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!config.adminToken) {
    res.status(503).json({ error: { message: "admin token not configured", type: "config_error" } });
    return;
  }
  const h = req.headers.authorization ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const ok =
    token.length === config.adminToken.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(config.adminToken));
  if (!ok) {
    res.status(401).json({ error: { message: "invalid admin token", type: "auth_error" } });
    return;
  }
  next();
}
