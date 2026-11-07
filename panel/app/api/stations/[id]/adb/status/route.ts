// GET /api/stations/[id]/adb/status — есть ли adb-связь с колонкой.
// adb уже внутри контейнера (Dockerfile: android-tools), ключи смонтированы в /home/node/.android.
import { NextRequest, NextResponse } from "next/server";
import { adbExec } from "@/lib/adb";
import { idToDevice } from "@/lib/stationsStore";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const device = idToDevice(id);
  if (!device) return NextResponse.json({ ok: false, error: "колонка не найдена" }, { status: 404 });

  const st = await adbExec(["-s", device, "get-state"], 8000);
  const state = st.stdout.trim();
  const connected = st.ok && state === "device";
  return NextResponse.json({
    ok: true,
    device,
    connected,
    state: connected ? "device" : st.ok ? state || "unknown" : "offline",
  });
}
