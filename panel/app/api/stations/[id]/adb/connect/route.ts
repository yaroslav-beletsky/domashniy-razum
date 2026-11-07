// POST /api/stations/[id]/adb/connect — adb connect к колонке (кнопка «Подключить»).
// force=true: даже если кэш connect свежий, переподключаемся (после reboot/offline).
import { NextRequest, NextResponse } from "next/server";
import { adbEnsureConnected, adbExec } from "@/lib/adb";
import { idToDevice } from "@/lib/stationsStore";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const device = idToDevice(id);
  if (!device) return NextResponse.json({ ok: false, error: "колонка не найдена" }, { status: 404 });

  await adbEnsureConnected(device, true);
  const st = await adbExec(["-s", device, "get-state"], 8000);
  const state = st.stdout.trim();
  const connected = st.ok && state === "device";
  return NextResponse.json({
    ok: true,
    device,
    connected,
    state: connected ? "device" : st.ok ? state || "unknown" : "offline",
    detail: connected ? `adb ${device}` : "станция не отвечает (adbd не на связи или колонка выключена)",
  });
}
