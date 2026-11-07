# agent-service

Тонкий OpenAI-совместимый шлюз для station-llm: колонки (через quasar-bridge) ходят сюда как в обычный LLM-эндпоинт, а внутри сервис добавляет системный промпт агента, выбирает модель LiteLLM и исполняет инструменты (MCP).

- Data-plane: `:4100` — `POST /v1/chat/completions` (как у OpenAI), `GET /v1/models`, `GET /health`
- Admin API: `/admin/*` — управление агентами, колонками, MCP-серверами (Bearer `AGENT_ADMIN_TOKEN`)
- Хранение: SQLite `secrets/agent/agent.db`, секреты — в `secrets/agent/mcp.env` (0600), в БД только имена
- LLM: домашний LiteLLM `http://litellm:4000/v1` (docker-сеть `home`)

## Быстрый старт (Mac mini 192.168.88.207)

```bash
cd /Users/yaroslav/Documents/home/station-llm/agent-service
mkdir -p secrets/agent && chmod 700 secrets/agent

# секреты (0600!). LITELLM_API_KEY — ключ LiteLLM
cat > secrets/agent/mcp.env <<'EOF'
LITELLM_API_KEY=sk-...       # ключ LiteLLM (master key)
AGENT_ADMIN_TOKEN=...        # случайная строка для /admin
EOF
chmod 600 secrets/agent/mcp.env

docker compose up -d --build
curl -s http://127.0.0.1:4100/health
```

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `LITELLM_BASE_URL` | `http://litellm:4000/v1` | Базовый URL LiteLLM |
| `LITELLM_API_KEY` | — (из mcp.env) | Ключ LiteLLM, ходит в заголовок Authorization |
| `AGENT_ADMIN_TOKEN` | — (из mcp.env) | Bearer для `/admin/*` |
| `MCP_STDIO_ALLOW` | — | Список разрешённых docker-образов для stdio MCP через запятую |
| `PORT` | `4100` | Порт сервиса |
| `KEY_PEPPER` / `KEY_PEPPER_FILE` | авто (secrets/agent/.pepper) | Pepper для хеша ключей колонок |

## Выпуск ключа колонки и привязка к агенту

```bash
TOKEN=...   # AGENT_ADMIN_TOKEN

# 1. агент
curl -s -X POST http://127.0.0.1:4100/admin/agents -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "slug": "home",
    "system_prompt": "Ты домашний помощник. Отвечай по делу.",
    "model": "op-gemini-3.8-flash",
    "fallback_model": "op-deepseek-v4.1-flash",
    "tools_enabled": ["*"]
  }'

# 2. станция
curl -s -X POST http://127.0.0.1:4100/admin/stations -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"device": "kitchen-mini"}'

# 3. привязка агента к станции
curl -s -X PUT http://127.0.0.1:4100/admin/stations/1/agent -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"agent_id": 1}'

# 4. ключ — открытый текст возвращается ОДИН раз
curl -s -X POST http://127.0.0.1:4100/admin/stations/1/key -H "Authorization: Bearer $TOKEN"
# {"key":"sk-station-kitchen-mini-<hex>","note":"shown once"}
```

## Переключение колонки

В quasar-bridge меняется только `QUASAR_LLM_BASE_URL` (прошивка не трогается):

```bash
QUASAR_LLM_BASE_URL=http://192.168.88.207:4100/v1
QUASAR_LLM_API_KEY=sk-station-kitchen-mini-<hex>   # ключ из шага 4
# model: "agent:home"
```

Если `model` НЕ начинается с `agent:` — запрос прозрачно уходит в LiteLLM (текущий выбор модели в панели продолжает работать).

## Проверка curl-ом

```bash
KEY=sk-station-kitchen-mini-<hex>
curl -s http://127.0.0.1:4100/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{
    "model": "agent:home",
    "stream": false, "temperature": 0, "max_tokens": 1024,
    "messages": [
      {"role":"system","content":"bridge default"},
      {"role":"user","content":"Который час?"}
    ]}'
```

## Тест агента (SSE)

```bash
curl -sN -X POST http://127.0.0.1:4100/admin/agents/1/test \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"prompt": "Который час?", "voice": false}'
# события: round / tool_call / delta / done{ms_total,rounds,fallback_used,chars}
```

## Подключение MCP

HTTP (Streamable HTTP) — пример Home Assistant:

```bash
# токен HA кладём в файловый секрет (значение не печатать)
curl -s -X PUT http://127.0.0.1:4100/admin/mcp/1/secrets \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"secrets":[{"name":"HA_TOKEN","value":"длинный-токен-home-assistant"}]}'

# сервер
curl -s -X POST http://127.0.0.1:4100/admin/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "name": "hass",
    "transport": "http",
    "url": "http://192.168.88.207:8123/api/mcp",
    "secret_refs": ["Authorization"],
    "timeout_ms": 2500
  }'
# далее: PUT /admin/mcp/1/secrets с {"secrets":[{"name":"Authorization","value":"Bearer <HA_TOKEN>"}]}
# инструменты появятся как hass__get_entities и т.п.
```

Замечания:
- Для http/sse значения секретов из `secret_refs`, чьи имена похожи на заголовки (`Authorization`, `X-...`), отправляются HTTP-заголовками.
- Для stdio: `cmd` — JSON `{"image":"...","args":[...]}`, образ обязан быть в `MCP_STDIO_ALLOW`; контейнер запускается как
  `docker run --rm -i --read-only --cap-drop ALL --memory 256m --network home -e <secret>=<value> <image> <args>`.
- Встроенный инструмент без MCP: `builtin__datetime` (время/дата) — включён при `tools_enabled: ["*"]` или явно.
- Пул следит за здоровьем каждые 30 с (`tools/list` в кэш `tools_cache`); circuit breaker: 3 ошибки → пауза 60 с.
- Команды: `POST /admin/mcp/:id/refresh` (перечитать инструменты), `GET /admin/mcp/:id/tools`.

## Ограничения и бюджеты

- Бюджет ответа агента: `budget_ms` (по умолчанию 6000 мс; мост даёт 60 с, запас большой).
- Tool-loop: ≤ `max_rounds` (3), вызовы в раунде параллельно, таймаут вызова `min(2500, остаток−1500)` мс,
  вывод инструмента ≤1500 симв., раунд ≤4000, JSON ужимается (null убраны, массивы до 5 + «…(+N)»),
  последний раунд — без tools, дубликаты `(tool, args)` в сессии отбрасываются.
- Фолбэк: `fallback_model` при ошибке основной модели; при исчерпании бюджета — финальный вызов без tools.
- Голос: к промпту добавляется суффикс «коротко, 2–3 фразы, без markdown»; на выходе режется `thinking`/markdown и ~600 символов.

## Admin API (кратко)

| Метод | Путь | Назначение |
|---|---|---|
| GET/POST | `/admin/agents` | список / создать |
| GET/PATCH/DELETE | `/admin/agents/:id` | читать / править (`If-Match: version`) / удалить |
| POST | `/admin/agents/:id/test` | SSE-прогон: round, tool_call, delta, done |
| GET/POST/PATCH/DELETE | `/admin/mcp` | MCP-серверы |
| POST | `/admin/mcp/:id/refresh` | обновить кэш инструментов |
| GET | `/admin/mcp/:id/tools` | кэшированные инструменты |
| PUT/GET | `/admin/mcp/:id/secrets` | записать секреты / увидеть `{name, set}` |
| GET | `/admin/stations` | список колонок |
| POST | `/admin/stations` | создать колонку `{device}` |
| GET/PUT | `/admin/stations/:id/agent` | агент колонки |
| POST | `/admin/stations/:id/key` | выпустить ключ (открытый текст один раз) |
| DELETE | `/admin/sessions/:station` | сбросить сессию колонки |
| GET | `/admin/audit?limit=` | аудит |

## Структура

```
src/
  index.ts            # entry: express, graceful shutdown
  config.ts secrets.ts db.ts auth.ts
  llm/litellm.ts      # OpenAI-совместимый клиент (stream/non-stream)
  loop/runner.ts      # tool-loop, бюджеты, дедуп, фолбэк
  loop/voice.ts       # голосовой суффикс и чистка ответа
  mcp/pool.ts         # соединения, health 30с, circuit breaker
  mcp/registry.ts     # агент → список инструментов
  mcp/tools.ts        # компрессия вывода, хедеры/_env из секретов, stdio allowlist
  routes/data.ts      # /v1/* — мост
  routes/admin.ts     # /admin/* — управление
```
