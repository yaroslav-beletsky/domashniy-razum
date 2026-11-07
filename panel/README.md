# station-llm · панель

Веб-пульт домашнего голосового стека: статус LiteLLM, тест моделей (бюджет навыка
Яндекс Диалогов ~4.5 с / ~1024 символа), голосовая цепочка (STT/TTS/ask),
управление колонкой с quasar-bridge, live-логи (SSE), статистика LiteLLM за 24 ч.
Мобильная вёрстка: bottom-nav, одна колонка, таблицы → карточки, тап-таргеты ≥44 px.

## Стек

Next.js 15 (App Router) + TypeScript + shadcn/ui (zinc, тёмная тема), бэкенд —
route handlers. Внутри контейнера: `adb` (android-tools) и `ssh` (openssh-client).

## Экраны

- **Пульт** (`/`) — LiteLLM, голос, ключ, счётчики, статистика 24 ч (из БД LiteLLM:
  запросы, ≤4.5 с, avg/p50/p95, ошибки, TTFT, по моделям/маршрутам), лента событий.
- **Модели** (`/models`) — список + «тест» (`/v1/chat/completions`).
- **Голос** (`/voice`) — health `/api/health` (опрос раз в 10 с), STT из файла,
  TTS (текст → WAV), полный круг (микрофон/файл → STT → LLM → TTS → аудио).
- **Станции** (`/stations`) — витрина карточек колонок (кольцо-индикатор: голубой «Алиса», фиолетовый «Гибрид», зелёный «LLM»,
  янтарный — рестарт/мост down, погасший — offline). `/stations/[id]` — деталь: три режима (см. ниже), пикер модели LiteLLM (поиск, недавние, группы, варианты), прогресс
  смены с откатом при отказе, живой SSE-лог. Колонки добавляются из UI (только частные IPv4);
  реестр — `panel-stations.json` в томе `secrets/adb`, колонки из `ADB_DEVICES` удалить нельзя.
- **Агенты** (`/agents`, `/agents/[id]`) — управление agent-service (:4100): карточки; редактор (персона, системный
  промпт с чипами `{{…}}`, основная/запасная модель через общий пикер, длина ответа → `max_tokens`, MCP-серверы и тогглы
  инструментов, секреты только по именам, колонки мультивыбором); «Сохранить» (PATCH с `If-Match`, 409 при конфликте) отделено от
  «Применить на колонки» (connect/disconnect по SSE); sticky тест-панель с лентой `tool_call` и таймингом (>4.5 с — янтарным).
  На карточке и странице станции — бейдж `Агент: …`, кнопки «Подключить к агенту» / «Отключить».
  Имя/аватар/описание агента хранятся в панели (`panel-agents.json`, том `secrets/adb`), остальное — в agent-service.
- **Мастер** (`/add-station`) — пошаговая настройка «нулевой» колонки до полного контроля (ветка A,
  см. `docs/add-station-wizard.md`): поиск в LAN (TCP-скан :5555), черновик с прогрессом (13 шагов,
  персистентно в `panel-wizard.json`), ручные шаги — инструкция + «Готово», автошаги — кнопка «Выполнить»
  с SSE-прогрессом (проверки + живой журнал), опасные шаги с явным подтверждением, авто-классификация
  точки входа для уже «тронутой» колонки (A.4). Автоматизированы: проверка стенда (HTTP), adb/root,
  OTA-проверка, установка моста (источник — локальный форк со сменой голоса TTS из
  `/opt/station-setup/quasar-bridge-fork/dist`; бандла нет — фолбэк на апстрим-релиз GitHub;
  после установки в `tts.override` на колонке пишется голос `WIZARD_BRIDGE_VOICE`, откат — `rm tts.override`),
  три слоя закрепления (пуш скриптов `station-setup/` по adb), блокировка
  обновлений + выгрузка бэкапа, режим/модель (через `apply`), регистрация в панели + привязка агента.
  Заглушки/TODO(v2): запись `dhcpcd.conf`, управление стендом
  (start/stop, `run/downgrade`), ARP/MAC/mDNS из контейнера.
- **Логи** (`/logs`) — SSE: `belch-voice`, `quasar-bridge`, `adb`, `panel`.

## API

| Эндпоинт | Назначение |
|---|---|
| `GET /api/status` | LiteLLM + голос + станция + ключ (без секретов) |
| `GET /api/stats?hours=24` | агрегаты из `LiteLLM_SpendLogs` |
| `GET /api/station` | статус моста + список моделей |
| `POST /api/station/mode` `{mode: alice\|hybrid\|llm}` | то же, что `apply` без SSE (`observe` = `alice`) |
| `GET\|POST /api/stations` | список колонок с живым статусом / добавить `{host, port?, name?, kind?}` |
| `GET\|PATCH\|DELETE /api/stations/[id]` | колонка (`?fresh=1` — без кэша 3 с) / имя, тип / удалить (только добавленные из UI) |
| `POST /api/stations/[id]/apply` `{mode?: alice\|hybrid\|llm, model?}` | SSE-прогресс: write → check → restart → wait; при отказе файлы откатываются |
| `GET\|POST /api/agents`, `GET\|PATCH\|DELETE /api/agents/[id]` | агенты (`id` — число или slug); PATCH: `{version, meta?, …поля}` |
| `POST /api/agents/[id]/test` `{prompt}` | SSE `round\|tool_call\|delta\|fallback\|done\|error` из agent-service (по сохранённому конфигу) |
| `GET\|POST /api/mcp`, `PATCH\|DELETE /api/mcp/[id]`, `POST …/refresh`, `GET …/tools`, `GET\|PUT …/secrets` | MCP-серверы; значения секретов назад не отдаются |
| `GET\|PUT /api/stations/[id]/agent` | привязка колонки к агенту в сервисе (без записи на колонку) |
| `POST /api/stations/[id]/connect-agents` `{agent}` / `disconnect-agents` | SSE: ключ колонки → `runtime.env` (+ `runtime.env.bak-agent` с исходными base_url/ключ/модель) → check → restart → wait; при отказе откат |
| `GET /api/logs/stream?source=quasar-bridge\|adb&station=<id>` | SSE-лог конкретной колонки |
| `POST /api/station/model` `{model}` | `QUASAR_LLM_MODEL` в `runtime.env`, `check`, `restart` |
| `POST /api/voice/stt` / `tts` / `ask` | прокси к voice-chain (multipart `file` / JSON `{text}`) |
| `GET /api/logs/stream?source=…` | SSE; без/с неизвестным source — одно событие `offline` |
| `POST /api/wizard/scan` `{subnet?}` | SSE-скан LAN: `progress`/`host`/`done {candidates}` |
| `GET\|POST /api/wizard/state` | черновики мастера; POST: `create`/`update`/`confirm`/`skip`/`back`/`delete` |
| `POST /api/wizard/run` `{key, step, params?}` | SSE-прогон автошага: `log`/`check`/`step`/`done`/`error`; шаги: `classify`, `stand`, `ota`, `adbroot`, `bridge`, `persist`, `staticip`, `noupdate`, `mode` `{mode?, model?}`, `register` `{name?, kind?, agent?}`, `test` |

### Режимы колонки

Мост сам знает только `observe` и `hybrid`; «LLM» — понятие панели. Режим в UI выводится из `mode` в `runtime.env`
и блока `routing` в `config.json`; остальные ключи конфига при смене сохраняются (JSON-merge).

| Режим | Мост | Что делает |
|---|---|---|
| **Алиса** | `mode=observe` | мост только проксирует в Яндекс, наша модель не участвует; `routing` и `listen_after_reply` не меняются |
| **Гибрид** | `mode=hybrid`, 6 правил `routing`, `default_route=llm`, классификатор выключен, `listen_after_reply=true` | музыка/радио/громкость, погода, таймеры/будильники/время и умный дом → Яндекс; всё остальное и «спроси нейросеть …» → модель |
| **LLM** | `mode=hybrid`, `rules=[]`, `default_route=llm`, `classifier.enabled=false`, `listen_after_reply=true` | всё → модель |

Классификатор в «Гибриде» выключен намеренно: стандартный промпт «при сомнении выбирай yandex» уводил бы обычные
вопросы к Алисе, а на каждую нераспознанную фразу добавился бы вызов LLM (до `timeout_ms`). Правила детерминированы
и проверяются без колонки: `quasar-bridge -config config.json -route '<фраза>'`.

`listen_after_reply=true` в «Гибрид»/«LLM»: после ответа модели колонка сама слушает следующую фразу, и повторять
«Алиса» не нужно. Продолжение приходит новым запросом и проходит через `routing` (при `default_route=llm` — в модель).
Проверено вживую на Станции .79: первый вопрос ушёл в модель, продолжение без активатора принято. В режиме «Алиса»
флаг не меняется. Правка флага требует рестарта моста, он и так выполняется при смене режима. Окно ожидания
следующей фразы определяет прошивка колонки; ответы самого Яндекса флаг не затрагивает. Если «хвост» всё же уйдёт
Яндексу (в логе `native_route route=yandex sent=true` без `native_route_decision`), верните `false` в `config.json`.

Смена режима/модели требует restart моста (~10–15 с): SIGHUP перечитывает только
маршрутизацию (`routing_reloaded`), не `QUASAR_MODE`/`QUASAR_LLM_MODEL`.

## Конфигурация

`.env` (см. `.env.example`):

| Переменная | Назначение |
|---|---|
| `LITELLM_BASE_URL` | LiteLLM (из colima: `http://host.docker.internal:4000`) |
| `LITELLM_API_KEY` | ключ LiteLLM, только сервер |
| `VOICE_CHAIN_URL` | голосовая цепочка, по умолчанию `http://192.168.88.23:10702` |
| `ADB_DEVICES` | станции через запятую, `192.168.88.79:5555` |
| `LITELLM_PG_DSN` | DSN Postgres LiteLLM (чтение), хост `litellm-db` в сети `home` |
| `AGENT_ADMIN_TOKEN` | Bearer-токен admin API agent-service, только сервер (из `agent-service/secrets/agent/mcp.env`) |
| `AGENT_SERVICE_URL` | agent-service из контейнера, по умолчанию `http://host.docker.internal:4100` |
| `AGENT_PUBLIC_BASE` | base_url, который прописывается колонке, `http://192.168.88.207:4100/v1` |
| `VOICE_LOG_SSH_TARGET` / `_KEY` / `_PATH` | ssh-tail лога voice-chain на .23 |
| `WIZARD_BRIDGE_FORK_DIST` | каталог форк-бандла моста внутри контейнера, `/opt/station-setup/quasar-bridge-fork/dist`; пусто = всегда апстрим с GitHub |
| `WIZARD_BRIDGE_VOICE` | голос ответа моста-форка: `ermil` (мужской, по умолчанию) \| `zahar` \| `oksana` \| `jane` \| `shitova` \| `omazh`; пишется в `/data/opt/quasar-bridge/tts.override`, откат — `rm tts.override` |
| `WIZARD_BRIDGE_VERSION` | версия апстрим-релиза GitHub для фолбэка, `0.7.4` |

Секреты монтируются из `~/Documents/home/station-llm/secrets/` (colima шарит только
`~/Documents`): `adb/` → `/home/node/.android`, `ssh/` → `/ssh:ro`. В репозиторий не попадают.

## Запуск (Docker, colima)

```bash
cp .env.example .env  # LITELLM_API_KEY, LITELLM_PG_DSN
PATH=/opt/homebrew/bin:$PATH docker compose up -d --build
```

Панель: `http://192.168.88.207:3110`. Нужна внешняя сеть `home` (`docker network ls`).

## Лог belch-voice

Лог живёт на .23 (`~/Documents/home/station-llm/voice-chain/logs/belch-voice.log`).
Панель читает его по ssh (read-only `tail`) выделенным ключом. Публичную часть
`secrets/ssh/id_ed25519.pub` нужно добавить в `~/.ssh/authorized_keys` на .23.
Пока ключа нет — источник честно показывает offline.
