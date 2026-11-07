# Архитектура agent-service

Тонкий OpenAI-совместимый слой между голосовым мостом колонок (quasar-bridge) и домашним LiteLLM.
«Притворяется» LLM-эндпоинтом: мост меняет только `QUASAR_LLM_BASE_URL`, прошивка колонки не трогается.

## Поток

```
Яндекс Станция → quasar-bridge → agent-service:4100 ──(agent:<slug>)──┐
                                          └─(обычная модель)──→ LiteLLM:4000 (прозрачный прокси)
                                                                  │
 agent-service: system prompt агента + voice suffix, tool-loop  ←┘
   → LiteLLM (model → fallback_model) → MCP tools (параллельно) → финальный стрим → voiceClean → мост
```

Мост шлёт `stream:false, temperature:0, max_tokens:1024` и историю (≤6 пар, TTL 300 с). Историю берём из
запроса; своя память (сессии SQLite) — дополнение: дедуп вызовов, метаданные. Таймаут моста 60 с,
бюджет агента ~6 с.

## Компоненты

| Модуль | Роль |
|---|---|
| `routes/data.ts` | Data-plane. Auth по `sk-station-*` (HMAC-sha256 + pepper). `model: agent:<slug>` → runner; иначе → прозрачный прокси в LiteLLM. `GET /v1/models` = модели LiteLLM + агенты. |
| `routes/admin.ts` | Admin API под `AGENT_ADMIN_TOKEN`. Агенты (PATCH с `If-Match: version`), станции, ключи (plaintext один раз), MCP, SSE-тест (`round/tool_call/delta/done`). |
| `loop/runner.ts` | Tool-loop: ≤3 раунда; параллельные вызовы; таймаут `min(2500, остаток−1500)`; вывод ≤1500/вызов, ≤4000/раунд; последний раунд `tool_choice:"none"`; дедуп `(tool,args)`; бюджет → финальный вызов без tools; ошибка → `fallback_model` → финальный без tools. |
| `loop/voice.ts` | Суффикс «коротко, 2–3 фразы, без markdown» в системный промпт; чистка `<thinking>`, markdown; обрезка ~600 симв. по границе предложения. |
| `llm/litellm.ts` | Клиент LiteLLM (OpenAI-совместимый): non-stream и SSE-стрим с аккумуляцией; таймаут 55 с; финальный ответ всегда стримится (TTFB). |
| `mcp/pool.ts` | Транспорты http (Streamable HTTP), sse, stdio (docker `run --read-only --cap-drop ALL --memory 256m --network home`, образ из `MCP_STDIO_ALLOW`). Пул коннектов, health каждые 30 с, кэш `tools/list`, circuit breaker: 3 ошибки → 60 с паузы. |
| `mcp/registry.ts` | Резолв инструментов агента: `tools_enabled: ["*"] | [имена]`; builtin `builtin__datetime`; имена `server__tool`. Упавший сервер просто не даёт инструментов (модель видит «недоступно» косвенно). |
| `db.ts` | SQLite `secrets/agent/agent.db`: `agents, stations, mcp_servers, sessions, audit`. |
| `secrets.ts` | `secrets/agent/mcp.env` (0600): значения секретов; в БД — только имена (`secret_refs`). |
| `auth.ts` | Станции: `Bearer sk-station-<device>` → HMAC-sha256(key, pepper) → station → agent. Admin: константное сравнение токена. |

## Схема данных (кратко)

- `agents(slug UNIQUE, system_prompt, model, fallback_model, tools_enabled JSON, max_rounds=3, budget_ms=6000, max_tokens=250, memory_turns=6, memory_ttl_s=300, version)`
- `stations(device UNIQUE, key_hash UNIQUE, agent_id→agents)`
- `mcp_servers(name, transport http|sse|stdio, url, cmd JSON{image,args}, secret_refs JSON, enabled, timeout_ms=2500, status, tools_cache, last_check_at)`
- `sessions(station UNIQUE, data JSON, updated_at)` — TTL 300 с
- `audit(ts, station_id, agent_id, event, meta)`

## Контракты и ограничения

- Наружу (мост) виден только `choices[0].message.content`; `tool_calls` внутренние.
- OpenAI-совместимость: поля `id/object/created/model/choices/usage`; SSE-чанки для `stream:true`.
- Агент привязан к станции: колонка с ключом станции X может звать только `agent:<slug>` своего агента (иначе 403).
- Быстрый путь (без инструментов): один вызов LLM, накладные сервиса ≤50 мс (замер в `agent_meta.overhead_ms`).
- Docker: сеть `home` (external), порт `4100`, `restart: unless-stopped`, healthcheck `/health`.

## Безопасность

- Ключи колонок — HMAC-sha256 с pepper (файл `secrets/agent/.pepper`, 0600); открытый ключ показывается один раз при выпуске.
- Секреты MCP живут только в `mcp.env` (0600); через API наружу — `{name, set}`.
- stdio MCP — только образы из allowlist, sandbox-флаги docker, сеть `home` изолирована от host.
- Секреты и ключи не логируются; audit пишет метаданные без значений.
