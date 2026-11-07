import { NextResponse } from "next/server";
import { config, keyConfigured } from "@/lib/config";
import { litellmStatus } from "@/lib/litellm";
import { voiceChainHealth } from "@/lib/voiceChain";
import { adbWarmup, firstDevice } from "@/lib/adb";
import { eventCounters } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function GET() {
  const [litellm, voice, station] = await Promise.all([
    litellmStatus(5000),
    voiceChainHealth(3500),
    adbWarmup().catch(() => false),
  ]);
  let baseUrlHost = "";
  try {
    baseUrlHost = new URL(config.litellmBaseUrl).host;
  } catch {
    baseUrlHost = config.litellmBaseUrl;
  }
  return NextResponse.json({
    litellm: {
      online: litellm.online,
      ms: litellm.ms,
      modelCount: litellm.modelCount,
      error: litellm.error,
      baseUrlHost,
    },
    voice: {
      online: voice.ok,
      ms: voice.ms,
      baseUrl: voice.baseUrl,
      sttEngine: voice.sttEngine,
      sttModel: voice.sttModel,
      ttsEngine: voice.ttsEngine,
      ttsVoice: voice.ttsVoice,
      belchReachable: voice.belchReachable,
      error: voice.error,
    },
    station: { device: firstDevice(), online: station },
    keyConfigured: keyConfigured(),
    uptimeSec: Math.floor((Date.now() - config.bootTime) / 1000),
    version: config.panelVersion,
    counters: eventCounters(),
  });
}
