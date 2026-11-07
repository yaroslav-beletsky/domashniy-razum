import { NextRequest, NextResponse } from "next/server";
import { addStation, listStations, parseDevice, STATION_KINDS, type StationKind } from "@/lib/stationsStore";
import { buildView } from "@/lib/stationView";
import { adbEnsureConnected } from "@/lib/adb";

export const dynamic = "force-dynamic";

/** Список колонок с живым статусом (параллельно, у каждой свой таймаут). */
export async function GET() {
  const stations = await Promise.all(listStations().map((m) => buildView(m)));
  const online = stations.filter((s) => s.reachable).length;
  return NextResponse.json({ ok: true, stations, online, offline: stations.length - online });
}

/** Добавить колонку: { host, port?, name?, kind? }. Только локальные IPv4. */
export async function POST(req: NextRequest) {
  let body: { host?: string; port?: number | string; name?: string; kind?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const parsed = parseDevice(body.host ?? "", body.port);
  if (!parsed.device) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  const kind = STATION_KINDS.includes(body.kind as StationKind) ? (body.kind as StationKind) : "unknown";
  const r = addStation(parsed.device, body.name, kind);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.error === "такая колонка уже есть" ? 409 : 500 });
  void adbEnsureConnected(parsed.device, true);
  return NextResponse.json({ ok: true, id: parsed.device.replace(":", "-") });
}
