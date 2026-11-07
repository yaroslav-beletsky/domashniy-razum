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
- **Станции** (`/stations`) — витрина карточек колонок (кольцо-индикатор: зелёный observe, фиолетовый hybrid,
  янтарный — рестарт/мост down, погасший — offline). `/stations/[id]` — деталь: режим `observe ↔ hybrid`
  (мост принимает только эти два), пикер модели LiteLLM (поиск, недавние, группы, варианты), прогресс
  смены с откатом при отказе, живой SSE-лог. Колонки добавляются из UI (только частные IPv4);
  реестр — `panel-stations.json` в томе `secrets/adb`, колонки из `ADB_DEVICES` удалить нельзя.
- **Логи** (`/logs`) — SSE: `belch-voice`, `quasar-bridge`, `adb`, `panel`.

## API

| Эндпоинт | Назначение |
|---|---|
| `GET /api/status` | LiteLLM + голос + станция + ключ (без секретов) |
| `GET /api/stats?hours=24` | агрегаты из `LiteLLM_SpendLogs` |
| `GET /api/station` | статус моста + список моделей |
| `POST /api/station/mode` `{mode: observe\|hybrid}` | правка `runtime.env` + `config.json`, `control.sh check`, `restart` |
| `GET\|POST /api/stations` | список колонок с живым статусом / добавить `{host, port?, name?, kind?}` |
| `GET\|PATCH\|DELETE /api/stations/[id]` | колонка (`?fresh=1` — без кэша 3 с) / имя, тип / удалить (только добавленные из UI) |
| `POST /api/stations/[id]/apply` `{mode?, model?}` | SSE-прогресс: write → check → restart → wait; при отказе файлы откатываются |
| `GET /api/logs/stream?source=quasar-bridge\|adb&station=<id>` | SSE-лог конкретной колонки |
| `POST /api/station/model` `{model}` | `QUASAR_LLM_MODEL` в `runtime.env`, `check`, `restart` |
| `POST /api/voice/stt` / `tts` / `ask` | прокси к voice-chain (multipart `file` / JSON `{text}`) |
| `GET /api/logs/stream?source=…` | SSE; без/с неизвестным source — одно событие `offline` |

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
| `VOICE_LOG_SSH_TARGET` / `_KEY` / `_PATH` | ssh-tail лога voice-chain на .23 |

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
