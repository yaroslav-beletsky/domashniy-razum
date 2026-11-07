// Сборка «вида» колонки для UI: реестр + живой статус + эффективное состояние.
import { stationStatus, isApplying, type BridgeInfo } from "./station";
import { defaultName, deviceToId, type StationMeta } from "./stationsStore";

export type StationState = "healthy" | "bridge-down" | "offline" | "applying";

export interface StationView {
  id: string;
  device: string;
  name: string;
  nameCustom: boolean;
  kind: string;
  extra: boolean;
  state: StationState;
  reachable: boolean;
  healthy: boolean;
  pid?: number;
  mode?: string;
  model?: string;
  ip?: string;
  firmware?: string;
  bridgeVersion?: string;
  error?: string;
  /** для оффлайн-карточки */
  last?: { at: number; model?: string; mode?: string; ip?: string; firmware?: string; bridgeVersion?: string };
}

function withTimeout(p: Promise<BridgeInfo>, ms: number, device: string): Promise<BridgeInfo> {
  return Promise.race([
    p,
    new Promise<BridgeInfo>((resolve) =>
      setTimeout(() => resolve({ device, reachable: false, running: false, healthy: false, error: "таймаут adb" }), ms),
    ),
  ]);
}

export async function buildView(meta: StationMeta, fresh = false, timeoutMs = 12000): Promise<StationView> {
  const applying = isApplying(meta.device);
  const info = await withTimeout(stationStatus(meta.device, fresh), timeoutMs, meta.device);
  const reachable = info.reachable;
  const state: StationState = applying ? "applying" : !reachable ? "offline" : info.healthy ? "healthy" : "bridge-down";
  return {
    id: deviceToId(meta.device),
    device: meta.device,
    name: meta.name ?? defaultName(meta.device),
    nameCustom: Boolean(meta.name),
    kind: meta.kind ?? "unknown",
    extra: meta.extra,
    state,
    reachable,
    healthy: info.healthy,
    pid: info.pid,
    mode: info.mode,
    model: info.model,
    ip: info.ip ?? meta.last?.ip ?? meta.device.split(":")[0],
    firmware: info.firmware,
    bridgeVersion: info.bridgeVersion,
    error: info.error,
    last: meta.last,
  };
}
