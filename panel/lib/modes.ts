// Режимы колонки в панели и их соответствие настройкам quasar-bridge. Без Node-зависимостей (импортируется и в клиенте).
//  alice  → mode=observe: мост только проксирует в Яндекс, наша модель не участвует.
//  hybrid → mode=hybrid + routing: медиа/погода/таймеры/умный дом → Яндекс, остальное → модель.
//  llm    → mode=hybrid + routing.default_route=llm, rules=[], classifier выключен: всё → модель.
// Мост принимает mode только observe|hybrid; "llm" — понятие панели.

export type PanelMode = "alice" | "hybrid" | "llm";
export const PANEL_MODES: PanelMode[] = ["alice", "hybrid", "llm"];

export const MODE_INFO: Record<PanelMode, { label: string; badge: string; hint: string }> = {
  alice: { label: "Алиса", badge: "Алиса", hint: "Обычная Алиса. Наша модель не участвует, мост только проксирует запросы в Яндекс." },
  hybrid: { label: "Гибрид", badge: "ГИБРИД", hint: "Музыка, погода, таймеры и умный дом — у Алисы, всё остальное — наша модель." },
  llm: { label: "LLM", badge: "LLM", hint: "Все запросы отвечает наша модель. Алиса только слышит и озвучивает." },
};

export function isPanelMode(v: unknown): v is PanelMode {
  return v === "alice" || v === "hybrid" || v === "llm";
}

/** Принимает и значения панели, и сырые значения моста/старых записей (observe → alice). */
export function normalizeMode(v: unknown): PanelMode | undefined {
  if (isPanelMode(v)) return v;
  if (v === "observe") return "alice";
  if (v === "hybrid") return "hybrid";
  return undefined;
}

export interface RoutingLike {
  rules?: unknown;
  default_route?: unknown;
  classifier?: { enabled?: unknown } | null;
}

/** Режим панели по режиму моста и блоку routing из config.json. */
export function derivePanelMode(bridgeMode: string | undefined, routing: RoutingLike | undefined): PanelMode | undefined {
  if (bridgeMode === "observe") return "alice";
  if (bridgeMode !== "hybrid") return undefined;
  const noRules = Array.isArray(routing?.rules) && routing.rules.length === 0;
  const allLlm = routing?.default_route === "llm" && routing?.classifier?.enabled !== true;
  return noRules && allLlm ? "llm" : "hybrid";
}

export const ROUTING_LLM = {
  rules: [] as unknown[],
  default_route: "llm",
  classifier: { enabled: false, on_error: "llm" },
};

// Правила применяются по порядку, первое совпадение побеждает. Классификатор выключен: правила детерминированы,
// а стандартный промпт классификатора «при сомнении выбирай yandex» уводил бы обычные вопросы к Алисе
// (и добавлял бы LLM-вызов с задержкой до timeout_ms на каждую нераспознанную фразу).
export const ROUTING_HYBRID = {
  rules: [
    {
      "name": "speaker_playback",
      "route": "yandex",
      "match": {
        "regex": "^\\s*(?:алиса[,\\s]+)?(?:пожалуйста[,\\s]+)?(?:хватит|стоп|пауза|останови(?:те)?|(?:останови(?:те)?|выключи(?:те)?|прекрати(?:те)?) (?:музыку|воспроизведение|песню|песни|трек|радио)|поставь(?:те)? на паузу|(?:продолжи(?:те)?|возобнови(?:те)?) (?:музыку|воспроизведение|песню|трек))[,\\s]*(?:пожалуйста)?[.!?]*\\s*$"
      }
    },
    {
      "name": "complex_queries",
      "route": "llm",
      "match": {
        "contains_any": [
          "спроси у нейросети",
          "спроси нейросеть",
          "спроси у своей модели",
          "спроси свою модель",
          "спроси модель",
          "напиши код",
          "напиши программу",
          "реши задачу",
          "проанализируй",
          "сравни варианты",
          "объясни подробно"
        ]
      }
    },
    {
      "name": "yandex_home",
      "route": "yandex",
      "match": {
        "contains_all_groups": [
          [
            "свет",
            "ламп",
            "люстр",
            "розетк",
            "штор",
            "кондиционер",
            "термостат",
            "обогрев",
            "вентилятор",
            "пылесос",
            "телевизор",
            "датчик",
            "температур",
            "влажност"
          ],
          [
            "включ",
            "выключ",
            "открой",
            "закрой",
            "установ",
            "постав",
            "сделай",
            "прибав",
            "убав",
            "температур",
            "влажност",
            "состояни",
            "проверь",
            "горит",
            "работает"
          ]
        ],
        "contains_none": [
          "песню",
          "песни",
          "музыку",
          "радио",
          "трек"
        ]
      }
    },
    {
      "name": "yandex_timers",
      "route": "yandex",
      "match": {
        "contains_any": [
          "таймер",
          "будильник",
          "напомни",
          "напоминани",
          "который час",
          "сколько времени",
          "какое число",
          "какой сегодня день",
          "день недели"
        ]
      }
    },
    {
      "name": "yandex_weather",
      "route": "yandex",
      "match": {
        "contains_any": [
          "погод",
          "сколько градусов",
          "температура на улице",
          "зонт"
        ]
      }
    },
    {
      "name": "yandex_media",
      "route": "yandex",
      "match": {
        "contains_any": [
          "музык",
          "песн",
          "трек",
          "радио",
          "плейлист",
          "альбом",
          "громкост",
          "погромче",
          "потише",
          "сделай громче",
          "сделай тише"
        ],
        "contains_none": [
          "напиши",
          "сочини",
          "придумай"
        ]
      }
    }
  ] as unknown[],
  default_route: "llm",
  classifier: { enabled: false, on_error: "llm" },
};
