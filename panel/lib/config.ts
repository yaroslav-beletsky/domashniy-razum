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
  // agent-service (admin API за Bearer-токеном; токен живёт только здесь, на сервере панели).
  agentServiceUrl: (process.env.AGENT_SERVICE_URL ?? "http://host.docker.internal:4100").replace(/\/+$/, ""),
  // Адрес data-plane, который прописывается колонке (колонка ходит с LAN, а не из docker-сети).
  agentPublicBase: (process.env.AGENT_PUBLIC_BASE ?? "http://192.168.88.207:4100/v1").replace(/\/+$/, ""),
  // Мастер «Добавить колонку» (ветка A). Стенд подготовки lite-kit: DNS+HTTPS (:80/:443).
  // Сертификат стенда самоподписанный (достраивается до trusted-цепочки на колонке) —
  // панель ходит туда с verify=false, это осознанно и только к стенду.
  standBaseUrl: (process.env.STAND_BASE_URL ?? "https://192.168.88.23").replace(/\/+$/, ""),
  // Подсеть для поиска колонок (мастер сканирует <subnet>.0/24 по TCP :5555 и alive-портам).
  wizardLanSubnet: (process.env.WIZARD_LAN_SUBNET ?? "192.168.88").replace(/\.+$/, ""),
  // Промежуточный резолвер, который колонка получит по DHCP при привязке (AdGuard в LAN).
  // Панель через него проверяет DNS-цепочку мастера: quasar.yandex.net → стенд.
  wizardDnsResolver: process.env.WIZARD_DNS_RESOLVER ?? "192.168.88.35",
  // Платформа колонки в query к check_updates стенда (probe «как колонка»).
  wizardPlatform: process.env.WIZARD_PLATFORM ?? "yandexmini_2",
  // Целевая прошивка: критерий шага OTA (колонка должна оказаться на этой версии).
  targetFirmware: process.env.WIZARD_TARGET_FIRMWARE ?? "0.369.1.46",
  // Мост quasar-bridge: версия апстрим-релиза GitHub — теперь только фолбэк,
  // если локального форк-бандла нет (см. bridgeForkDist ниже).
  bridgeVersion: process.env.WIZARD_BRIDGE_VERSION ?? "0.7.4",
  // Локальный кэш скачанного апстрим-релиза (внутри adbHome, чтобы rsync/backup его видели).
  bridgeCacheDir: process.env.WIZARD_BRIDGE_CACHE_DIR ?? "",
  // Основной источник: локальный ФОРК моста со сменой голоса TTS (station-setup/quasar-bridge-fork/,
  // dist собирается build.sh). Мастер берёт готовый пакет quasar-bridge-linux-<arch>.tar.gz (+ .sha256)
  // из этого каталога (station-setup смонтирован в контейнер read-only); файла нет — качает
  // апстрим-релиз с GitHub (тот отвечает женским голосом). Пустая строка = всегда апстрим.
  bridgeForkDist: process.env.WIZARD_BRIDGE_FORK_DIST ?? "/opt/station-setup/quasar-bridge-fork/dist",
  // Голос ответа моста-форка: строка voice=… в /data/opt/quasar-bridge/tts.override на колонке.
  // Форк читает файл на каждый ответ — рестарт не нужен; откат голоса — rm tts.override.
  // Сервер принимает: ermil (мужской, проверен на слух), zahar, oksana, jane, shitova, omazh.
  bridgeVoice: process.env.WIZARD_BRIDGE_VOICE ?? "ermil",
  // Ручная подмена бандла (перекрывает и форк, и апстрим). Приоритет: TARBALL > форк > релиз GitHub.
  //  WIZARD_BRIDGE_TARBALL — путь к готовому пакету .tar.gz (в формате релиза; рядом <файл>.sha256 — по желанию),
  //  WIZARD_BRIDGE_BINARY  — путь к одному бинарю arm64: кладётся поверх bin/quasar-bridge ТОЛЬКО апстрим-пакета
  //  (поверх форка подменять бинарь нельзя — потеряется смена голоса).
  bridgeTarball: process.env.WIZARD_BRIDGE_TARBALL ?? "",
  bridgeBinary: process.env.WIZARD_BRIDGE_BINARY ?? "",
  // Data-plane по умолчанию для свежей установки (модель — из черновика мастера или дефолт ниже).
  bridgeDefaultModel: process.env.WIZARD_BRIDGE_DEFAULT_MODEL ?? "cp-self-kimi-k2.5",
  // Скрипты подготовки колонки (station-setup/), смонтированные в контейнер read-only.
  stationSetupDir: process.env.STATION_SETUP_DIR ?? "/opt/station-setup",
  bootTime: Date.now(),
  panelVersion: "0.3.0",
};

/** Ключ задан (само значение не отдаём наружу ни при каких условиях). */
export function litellmApiKey(): string {
  return process.env.LITELLM_API_KEY ?? "";
}

export function agentAdminToken(): string {
  return process.env.AGENT_ADMIN_TOKEN ?? "";
}

export function keyConfigured(): boolean {
  return litellmApiKey().length > 0;
}
