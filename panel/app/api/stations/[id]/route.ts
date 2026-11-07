import { NextRequest, NextResponse } from "next/server";
import { idToDevice, listStations, removeStation, updateStation } from "@/lib/stationsStore";
import { buildView } from "@/lib/stationView";
import { agentFetch } from "@/lib/agentApi";
import { findSvcStation, stationChipsMeta } from "@/lib/agentBind";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const device = idToDevice(id);
  if (!device) return NextResponse.json({ ok: false, error: "колонка не найдена" }, { status: 404 });
  const meta = listStations().find((s) => s.device === device)!;
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  return NextResponse.json({ ok: true, station: await buildView(meta, fresh) });
}

/** Переименование / тип: { name?, kind? } */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const device = idToDevice(id);
  if (!device) return NextResponse.json({ ok: false, error: "колонка не найдена" }, { status: 404 });
  let body: { name?: string; kind?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const r = updateStation(device, { name: body.name, kind: body.kind });
  if (r.ok && body.name !== undefined) {
    // Лучшее старание: переименовали комнату — обновляем и в agent-service,
    // чтобы чипы {{room}}/{{station_name}} в промпте агента не устарели.
    const f = await findSvcStation(device);
    if (f.ok && f.station) {
      await agentFetch(`/stations/${f.station.id}`, {
        method: "PATCH",
        body: stationChipsMeta({ device, name: body.name }),
        timeoutMs: 5000,
      }).catch(() => undefined);
    }
  }
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}

/** Удалить колонку, добавленную из UI. Колонки из ADB_DEVICES удалить нельзя. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const device = idToDevice(id);
  if (!device) return NextResponse.json({ ok: false, error: "колонка не найдена" }, { status: 404 });
  const r = removeStation(device);
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
