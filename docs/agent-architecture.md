# Архитектура agent-service

Инженерная справка по сервису `agent-service`. Описывает то, что реально реализовано
в коде (`agent-service/src/**`), а не проектные пожелания.

## Назначение

`agent-service` — тонкий **OpenAI-совместимый фасад** между голосовым мостом колонок
(quasar-bridge) и домашним LiteLLM. Для моста сервис выглядит как обычный LLM-эндпоинт
(`POST /v1/chat/completions`): прошивка колонки не трогается, меняется только
`QUASAR_LLM_BASE_URL`. Внутри сервис:

- достаёт агента по `slug` и добавляет его системный промпт (плюс голосовой суффикс);
- при необходимости гоняет **tool-calling loop** через MCP-инструменты;
- вызывает LiteLLM как upstream-модель и стримит финальный ответ обратно мосту;
- чистит ответ под голос (обрезка markdown/`thinking`, лимит длины).

Если `model` не начинается с `agent:` — запрос прозрачно проксируется в LiteLLM, так что
обычный выбор модели в панели продолжает работать.

## Поток запроса

```
Колонка → quasar-bridge → agent-service:4100
                              │  model = agent:<slug>?
                ┌─────────────┴───────────────┐
               нет                           да
                │                             │
        прозрачный прокси              tool-loop (≤3 раунда)
        в LiteLLM:4000/v1              ├─ системный промпт агента + голосовой суффикс
                                       ├─ LiteLLM chat/completions (model → fallback_model)
                                       ├─ MCP-инструменты (параллельно, лимиты)
                                       └─ финальный стрим → voiceClean → мост
```

Мост шлёт `stream:false, temperature:0, max_tokens:1024` и историю (≤6 пар, TTL 300 с);
историю сервис берёт из запроса, сессия в SQLite — только дополнение (дедуп вызовов,
метаданные). Таймаут моста 60 с, бюджет ответа агента ~6 с.

## Компоненты

| Модуль | Роль |
|---|---|
| `index.ts` | Express-приложение: `exprjson` 4 МБ, заголовок `X-Service`, монтирование роутеров, 404/500, listen, graceful shutdown (SIGTERM/SIGINT), запуск health-loop MCP. |
| `config.ts` | Конфиг из env (порт 4100, `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `AGENT_ADMIN_TOKEN`, пути к БД/секретам, `MCP_STDIO_ALLOW`). Pepper для ключей колонок: из env либо из файла `secrets/agent/.pepper` (создаётся 0600 при первом старте). `assertBootConfig()` предупреждает о нехватке ключей. |
| `routes/data.ts` | Data-plane. Auth по `sk-station-*`. `agent:<slug>` → `runAgent`; иначе — прозрачный прокси в LiteLLM. `GET /v1/models` = модели LiteLLM + агенты. |
| `routes/admin.ts` | Admin API под `AGENT_ADMIN_TOKEN`: CRUD агентов (PATCH с `If-Match: version`), станции, выпуск ключей, CRUD MCP, секреты MCP, SSE-тест агента, сброс сессий, аудит. |
| `loop/runner.ts` | Tool-loop: ≤`max_rounds`; параллельные вызовы; таймаут `min(2500, остаток−1500)`; вывод ≤1500/вызов, ≤4000/раунд; последний раунд без tools (`tool_choice:"none"`); дедуп `(tool,args)`; исчерпание бюджета → финальный вызов без tools; ошибка LLM → `fallback_model` → финальный без tools. |
| `loop/voice.ts` | Суффикс «коротко, 2–3 фразы, без markdown» в системный промпт; чистка `<thinking>`/токенизаторных артефактов/markdown; обрезка ~600 симв. по границе предложения. |
| `llm/litellm.ts` | OpenAI-совместимый клиент LiteLLM: non-stream `chat()` и SSE-стрим `chatStream()` с аккумуляцией контента и tool_calls; таймаут 55 с; `LlmError`. |
| `mcp/pool.ts` | Пул MCP-коннектов. Транспорты http (Streamable HTTP), sse, stdio (docker `run --rm -i --read-only --cap-drop ALL --memory 256m --network home`, образ из `MCP_STDIO_ALLOW`). Health каждые 30 с (обновление `tools_cache`), circuit breaker: 3 ошибки → пауза 60 с. |
| `mcp/registry.ts` | Резолв инструментов агента: `tools_enabled: ["*"] | [имена]`; builtin `builtin__datetime`; имена `server__tool`. Упавший сервер просто не отдаёт инструментов. |
| `mcp/tools.ts` | Сжатие вывода (`compress`/`compressRound`), дедуп-ключ, HTTP-заголовки и env для stdio из `secret_refs`, разбор и проверка allowlist для stdio `cmd`. |
| `db.ts` | SQLite (better-sqlite3, WAL, `foreign_keys=ON`): схема `agents/stations/mcp_servers/sessions/audit`, типы строк, `audit()`, сессии с TTL. |
| `secrets.ts` | Файловый стор секретов `secrets/agent/mcp.env` (0600): значения там; в БД хранятся только имена (`secret_refs`). |
| `auth.ts` | Станции: `Bearer sk-station-<...>` → HMAC-sha256(key, pepper) → станция → агент. Admin: `Bearer`-токен со сравнением `timingSafeEqual`. |

## Эндпоинты

Data-plane (auth — ключ станции `Bearer sk-station-*`):

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/health` | Живость (без auth): `ok`, `uptime_s`, адрес LiteLLM. |
| GET | `/v1/models` | Модели LiteLLM + агенты (`agent:<slug>`). |
| POST | `/v1/chat/completions` | `agent:<slug>` → агент; иначе — прокси в LiteLLM. `stream:true` поддержан. |

Admin API (`/admin/*`, Bearer `AGENT_ADMIN_TOKEN`):

| Метод | Путь | Назначение |
|---|---|---|
| GET / POST | `/admin/agents` | список / создать агента |
| GET / PATCH / DELETE | `/admin/agents/:id` | читать / править (`If-Match: version`) / удалить |
| POST | `/admin/agents/:id/test` | SSE-прогон: `round`, `tool_call`, `delta`, `fallback`, `done` |
| GET / POST | `/admin/mcp` | список / создать MCP-сервер |
| PATCH / DELETE | `/admin/mcp/:id` | править / удалить MCP-сервер |
| POST | `/admin/mcp/:id/refresh` | перечитать `tools/list` в кэш |
| GET | `/admin/mcp/:id/tools` | кэшированные инструменты |
| PUT / GET | `/admin/mcp/:id/secrets` | записать секреты / увидеть `{name, set}` |
| GET / POST | `/admin/stations` | список / создать станцию `{device}` |
| GET / PUT | `/admin/stations/:id/agent` | получить / привязать агента станции |
| POST | `/admin/stations/:id/key` | выпустить ключ (plaintext один раз) |
| DELETE | `/admin/sessions/:station` | сбросить сессию станции |
| GET | `/admin/audit?limit=` | последние записи аудита (≤200) |

## Хранение

- SQLite `secrets/agent/agent.db` (путь через `AGENT_DB_PATH`), режим WAL. Таблицы:
  - `agents(slug UNIQUE, system_prompt, model, fallback_model, tools_enabled JSON, max_rounds=3, budget_ms=6000, max_tokens=250, memory_turns=6, memory_ttl_s=300, version, created_at, updated_at)`;
  - `stations(device UNIQUE, key_hash UNIQUE, agent_id→agents, created_at, updated_at)`;
  - `mcp_servers(name UNIQUE, transport http|sse|stdio, url, cmd JSON, secret_refs JSON, enabled, timeout_ms=2500, status, tools_cache, last_check_at)`;
  - `sessions(station UNIQUE, data JSON, updated_at)` — TTL 300 с;
  - `audit(ts, station_id, agent_id, event, meta)` + индекс по `ts`.
- Секреты MCP — файл `secrets/agent/mcp.env` (0600); значения в БД не пишутся, только имена.
- Pepper для ключей станций — `secrets/agent/.pepper` (0600).
- В git `secrets/`, `.env`, `node_modules`, `dist` не попадают.

## Лимиты и устойчивость

- Бюджет ответа агента `budget_ms` (по умолчанию 6000 мс).
- Tool-loop: ≤ `max_rounds` (3); вызовы раунда параллельны; таймаут вызова `min(2500, остаток−1500)`;
  вывод инструмента ≤1500 симв., раунд ≤4000 (JSON ужимается: null убраны, массивы до 5);
  последний раунд — без tools; повтор `(tool, args)` в сессии отбрасывается.
- Бюджет исчерпан → финальный вызов без tools; ошибка LLM → `fallback_model` → финальный без tools;
  совсем не вышло → фиксированный текст-заглушка, `finish:"error"`.
- Circuit breaker на MCP: 3 ошибки подряд → 60 с паузы → `status:"circuit_open"`.
- Накладные расходы быстрого пути (без инструментов) измеряются в `agent_meta.overhead_ms`.

## Безопасность

- Admin: `Bearer AGENT_ADMIN_TOKEN`, сравнение через `crypto.timingSafeEqual`; без токена — 503.
- Ключи колонок: формат `sk-station-<device>-<hex>`, в БД хранится HMAC-sha256 с pepper;
  plaintext выдаётся только при выпуске.
- Секреты MCP живут в `mcp.env` (0600); наружу — только `{name, set}`.
- stdio MCP — только образы из `MCP_STDIO_ALLOW`, запуск в sandbox-контейнере в сети `home`.
- Сервис слушает порт `4100` (в docker-сети `home`, публикуется `4100:4100`), healthcheck `/health`,
  `restart: unless-stopped`. Ключи и секреты не логируются; audit пишет метаданные без значений.
