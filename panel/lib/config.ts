// Конфиг панели. Только сервер: ключ LiteLLM никогда не попадает в клиентский бандл.
export const config = {
  litellmBaseUrl: (process.env.LITELLM_BASE_URL ?? "http://192.168.88.207:4000").replace(/\/+$/, ""),
  belchVoiceHost: process.env.BELCH_VOICE_HOST ?? "host.docker.internal",
  belchVoicePort: Number(process.env.BELCH_VOICE_PORT ?? 10700),
  // Колонка(и) со quasar-bridge, доступные по adb (LAN tcpip). Формат: host:port[,host:port…]
  adbDevices: (process.env.ADB_DEVICES ?? "192.168.88.79:5555")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  adbPath: process.env.ADB_PATH ?? "adb",
  adbHome: process.env.ADB_HOME ?? "/home/node",
  adbTimeoutMs: Number(process.env.ADB_TIMEOUT_MS ?? 12000),
  // Tail-источники логов (whitelist). Каталоги хоста монтируются в контейнер read-only.
  belchLogDir: process.env.BELCH_VOICE_LOG_DIR ?? "/logs/belch-voice",
  quasarDataDir: process.env.QUASAR_DATA_DIR ?? "/logs/quasar",
  pgDsn: process.env.LITELLM_PG_DSN ?? "",
  // Голосовая цепочка (HTTP, LAN): health/stt/tts/ask. Поднята на отдельном хосте.
  voiceChainUrl: (process.env.VOICE_CHAIN_URL ?? "http://192.168.88.23:10702").replace(/\/+$/, ""),
  voiceChainTimeoutMs: Number(process.env.VOICE_CHAIN_TIMEOUT_MS ?? 60000),
  // Доступ к логам voice-chain на другом Mac по ssh (read-only, tail). Пароль не нужен:
  // ключ смонтирован в контейнер, публичная часть добавлена в authorized_keys на .23.
  voiceLogSshTarget: process.env.VOICE_LOG_SSH_TARGET ?? "yaroslav@192.168.88.23",
  voiceLogSshKey: process.env.VOICE_LOG_SSH_KEY ?? "/ssh/id_ed25519",
  voiceLogSshPath: process.env.VOICE_LOG_SSH_PATH ?? "~/Documents/home/station-llm/voice-chain/logs/belch-voice.log",
  bootTime: Date.now(),
  panelVersion: "0.2.0",
};

/** Ключ задан (само значение не отдаём наружу ни при каких условиях). */
export function litellmApiKey(): string {
  return process.env.LITELLM_API_KEY ?? "";
}

export function keyConfigured(): boolean {
  return litellmApiKey().length > 0;
}
