// Связка «колонка панели ↔ станция agent-service». id станции в сервисе числовой и свой;
// device в сервисе = id колонки панели (`192.168.88.79-5555`, подходит под ^[a-zA-Z0-9][a-zA-Z0-9._-]{1,60}$).
import { agentFetch } from "./agentApi";
import { defaultName, deviceToId } from "./stationsStore";

export interface SvcStation {
  id: number;
  device: string;
  agent_id: number | null;
  agent_slug: string | null;
  has_key: number;
  name?: string | null;
  room?: string | null;
}

export async function findSvcStation(device: string): Promise<{ ok: boolean; station?: SvcStation; error?: string }> {
  const r = await agentFetch<SvcStation[]>("/stations");
  if (!r.ok) return { ok: false, error: r.error };
  const key = deviceToId(device);
  return { ok: true, station: (r.data ?? []).find((s) => s.device === key) };
}

/** Данные колонки для чипов {{station_name}}/{{room}}: комната из UI, имя — комната или дефолт. */
export function stationChipsMeta(meta: { device: string; name?: string }): { name: string; room: string } {
  return { name: meta.name?.trim() || defaultName(meta.device), room: meta.name?.trim() || "" };
}

/** Лучше-старание: передать агенту имя/комнату колонки. Ошибка не роняет подключение. */
async function syncStationMeta(stationId: number, chips: { name: string; room: string }): Promise<void> {
  await agentFetch(`/stations/${stationId}`, { method: "PATCH", body: chips, timeoutMs: 5000 }).catch(() => undefined);
}

/** Станция в сервисе: находим или создаём при первом подключении; имя/комната — для чипов в промпте. */
export async function ensureSvcStation(device: string, meta?: { name?: string }): Promise<{ ok: boolean; station?: SvcStation; error?: string }> {
  const f = await findSvcStation(device);
  if (!f.ok) return f;
  if (!f.station) {
    const c = await agentFetch<{ id: number }>("/stations", {
      method: "POST",
      body: { device: deviceToId(device), ...stationChipsMeta({ device, name: meta?.name }) },
    });
    if (!c.ok) return { ok: false, error: c.error };
    return { ok: true, station: { id: c.data!.id, device: deviceToId(device), agent_id: null, agent_slug: null, has_key: 0 } };
  }
  // уже есть — обновляем имя/комнату (переименовали комнату в панели)
  await syncStationMeta(f.station.id, stationChipsMeta({ device, name: meta?.name }));
  return f;
}

export async function bindAgent(stationId: number, agentId: number | null) {
  return agentFetch(`/stations/${stationId}/agent`, { method: "PUT", body: { agent_id: agentId } });
}

/** Отзыв ключа колонки (key_hash → NULL). Лучше-старание: вызывается после успешной отвязки, ошибка не откатывает её. */
export async function revokeKey(stationId: number): Promise<{ ok: boolean; error?: string }> {
  const r = await agentFetch(`/stations/${stationId}/key`, { method: "DELETE", timeoutMs: 5000 });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** Снять привязку колонки в agent-service и отозвать её ключ (отзыв не критичен: ошибка только в результат). */
export async function releaseStation(stationId: number): Promise<{ unbound: boolean; revoked: boolean; error?: string }> {
  const u = await bindAgent(stationId, null);
  const k = await revokeKey(stationId);
  return { unbound: u.ok, revoked: k.ok, error: k.ok ? undefined : k.error };
}

/** Новый ключ колонки (в ответе один раз; дальше только хэш в сервисе). */
export async function mintKey(stationId: number): Promise<{ key?: string; error?: string }> {
  const r = await agentFetch<{ key?: string }>(`/stations/${stationId}/key`, { method: "POST" });
  return r.ok && r.data?.key ? { key: r.data.key } : { error: r.error ?? "ключ не выпущен" };
}
