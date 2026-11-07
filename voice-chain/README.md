# voice-chain — голосовая цепочка STT→LLM→TTS без Алисы

Поднято 7 ноября 2026. Работает на Mac (`192.168.88.23`, тот же, где adb и телефон),
STT/TTS считаются на телефоне SM-G780G (`RF8T60VDLHE`) через adb, LLM — домашний
LiteLLM на Mac mini (`192.168.88.207:4000`).

## Адрес для панели

```
http://192.168.88.23:10702
```

Проверено с Mac mini `.207` — доступен по LAN.

## Эндпоинты

| Метод | Путь | Что делает |
|-------|------|-----------|
| GET  | `/api/health` | статус, имена движков, reachable LiteLLM |
| POST | `/api/stt` | аудио (multipart `audio` или `Content-Type: audio/*`) → `{text, language, duration_ms}` |
| POST | `/api/tts` | JSON `{text}` или `?text=...` → WAV 22050 Hz |
| POST | `/api/ask` | multipart `audio` → STT → LiteLLM → TTS, отдаёт JSON + `audio_url` |
| GET  | `/api/audio/{id}` | закэшированное WAV из `/api/ask` |
| POST | `/tts/synthesize` | интеграторский вариант TTS (X-Duration, X-Waveform) |
| WS   | `/stt/stream` | стриминговый STT |

## Архитектура

- **belch-voice** (веб-режим, `belch_voice.web_main`), конфиг — `config.yaml`.
- Новые движки (в репо belch-voice, не закоммичены):
  - `belch_voice/stt/gigaam_phone.py` — GigaAM v3 (sherpa-onnx Nemo CTC) на телефоне:
    push WAV в `/data/local/tmp/belch-stt`, запуск `sherpa-onnx-offline`, парсинг JSON.
  - `belch_voice/tts/piper_phone.py` — Piper (sherpa-onnx VITS, голос Ирина) на телефоне:
    генерация лексикона для новых слов через локальный `espeak-ng` (кэш `lexicon-ru.txt`),
    push в `/data/local/tmp/belch-tts`, запуск `sherpa-onnx-offline-tts`, pull WAV.
- Оркестратор — `openai_compat` → `http://192.168.88.207:4000/v1`, модель `op-glm-5.3-flash`.
  Внимание: `cp-self-zai-glm-5.3-flash` в LiteLLM зависает (проверено curl-ом, нестрим и стрим) —
  не использовать, пока не починят.

## Телефон (проджектирование)

Что лежит на телефоне (пушается один раз через adb):

- `/data/local/tmp/belch-stt/`: `sherpa-onnx-offline`, `libc++_shared.so`,
  `model.int8.onnx` (GigaAM v3), `tokens.txt`
- `/data/local/tmp/belch-tts/`: `sherpa-onnx-offline-tts`, `libc++_shared.so`,
  `ru_RU-irina-medium.onnx(.json)`, `tokens.txt`, `lexicon.txt` (обновляется сервисом),
  `espeak-ng-data/` (не обязательно — лексикон генерим на Mac)

Если телефон перезагрузился — файлы в `/data/local/tmp` исчезают, надо пушить заново
(источники: `/private/var/folders/.../opencode/station-gigaam` и `station-piper`).
Доступ к Termux с этой машины не работает (RUN_COMMAND не выдан, не root), поэтому
всё идёт через `adb shell` от uid shell — этого достаточно.

## Сервис

launchd: `~/Library/LaunchAgents/com.yaroslav.station-voice.plist` (копия — здесь).

```
launchctl kickstart gui/$(id -u)/ru.yaroslav.station-voice   # рестарт
```

Зависимости сервиса: телефон подключен по USB с включённым adb, Mac в сети,
LiteLLM на `.207` жив. KeepAlive перезапускает процесс, но без телефона health
будет отдавать 500 на STT/TTS.

## Логи

- JSON-лог приложения (rotate 50MB × 5): `logs/belch-voice.log` — панель может tail-ить.
- stdout/stderr launchd: `logs/launchd.out.log`, `logs/launchd.err.log`.

## Измеренные задержки (короткая фраза)

- STT: ~1.6 с (включая push по adb)
- LLM (op-glm-5.3-flash, стрим): ~3–5 с до полного ответа
- TTS: ~1.5–2.4 с + espeak-ng для новых слов (~0.1 с/слово)
- Полный круг `/api/ask`: ~6–9 с

## Что осталось

- [ ] Панель: прописать `http://192.168.88.23:10702` как голосовой шлюз.
- [ ] При желании — fallback-модель в конфиге (`fallback_base_url` уже поддерживается).
- [ ] Рассмотреть поднятие STT/TTS локально на Mac (whisper/piper в belch-voice уже есть),
      чтобы не зависеть от подключенного телефона.
