#!/bin/bash
# station-ready.sh — доводит ЛЮБУЮ Яндекс Станцию до «готова к панели» за один проход.
# Идемпотентен: повторный запуск безопасен (проверяет и пропускает сделанное).
# Ручных действий: два Enter (сброс, Wi-Fi). Остальное — авто.
#
# Требования: Mac с adb, стенд lite-kit на 192.168.88.23, DNS quasar.yandex.* → стенд.
set -u

# ── конфигурация (без секретов) ──────────────────────────────────────────
STAND_HOST="${STAND_HOST:-192.168.88.23}"
STAND_URL="${STAND_URL:-https://${STAND_HOST}}"
DNS_RESOLVER="${DNS_RESOLVER:-192.168.88.35}"
QUASAR_DOMAINS="${QUASAR_DOMAINS:-quasar.yandex.net quasar.yandex.ru scbh.yandex.net}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATION_SETUP_DIR="${STATION_SETUP_DIR:-${SCRIPT_DIR}/station-setup}"
BRIDGE_FORK_DIST="${BRIDGE_FORK_DIST:-${STATION_SETUP_DIR}/quasar-bridge-fork/dist}"
BRIDGE_CACHE_DIR="${BRIDGE_CACHE_DIR:-${SCRIPT_DIR}/.bridge-cache}"
BRIDGE_VERSION="${BRIDGE_VERSION:-3.7.2}"
LITELLM_BASE_URL="${LITELLM_BASE_URL:-https://litellm.home.ru}"
# LAN-адрес LiteLLM для моста (колонка ходит по локальной сети, без TLS-CA)
LITELLM_LAN_URL="${LITELLM_LAN_URL:-http://192.168.88.207:4000/v1}"
LITELLM_MODEL="${LITELLM_MODEL:-vnc-cyber-deepseek-v4-1-flash-uncensored}"
LITELLM_API_KEY="${LITELLM_API_KEY:-}"              # задать в env или ~/.station-ready.env
# Маршрут LLM по умолчанию — через НАШЕГО агента (agent-service), как у mini .79.
# Один агент на все колонки: модель всегда agent:<slug>, ключ колонки выпускает агент.
# USE_AGENT=1 (по умолчанию) — новая рутнутая колонка идёт в агента; 0 — напрямую в LiteLLM.
USE_AGENT="${USE_AGENT:-1}"
AGENT_SERVICE="${AGENT_SERVICE:-http://192.168.88.207:4100}"
AGENT_LAN_URL="${AGENT_LAN_URL:-http://192.168.88.207:4100/v1}"
AGENT_MODEL="${AGENT_MODEL:-agent:home}"
AGENT_ADMIN_TOKEN="${AGENT_ADMIN_TOKEN:-}"          # задать в env или ~/.station-ready.env
BRIDGE_VOICE="${BRIDGE_VOICE:-ermil}"
YANDEX_OUI="${YANDEX_OUI:-b8:87:6e}"

# --target MAC  : работать строго с этой колонкой (отсев чужих клиентов стенда)
# --platform P  : форсировать платформу (yandexmini_2 / yandexmidi), не угадывать
TARGET_MAC="${TARGET_MAC:-}"
FORCED_PLATFORM="${FORCED_PLATFORM:-}"

STATE_DIR="${STATE_DIR:-${SCRIPT_DIR}/.station-ready-state}"
mkdir -p "$STATE_DIR"

# цвета — только для заголовков шагов
BOLD="$(tput bold 2>/dev/null || echo '')"
GREEN="$(tput setaf 2 2>/dev/null || echo '')"
RED="$(tput setaf 1 2>/dev/null || echo '')"
YELLOW="$(tput setaf 3 2>/dev/null || echo '')"
RESET="$(tput sgr0 2>/dev/null || echo '')"

# ── утилиты ──────────────────────────────────────────────────────────────

say()  { echo "${BOLD}[*]${RESET} $*"; }
ok()   { echo " ${GREEN}✓${RESET} $*"; }
err()  { echo "${RED}[!]${RESET} $*" >&2; }
warn() { echo "${YELLOW}[~]${RESET} $*"; }
ask()  { printf "${BOLD}[?]${RESET} %s " "$*"; }

die() {
  err "$@"
  exit 1
}

# состояние между запусками: ключ — IP колонки (или MAC после обнаружения)
state_file() {
  local id="$1"
  echo "${STATE_DIR}/${id//[:\/]/-}.json"
}

state_get() {
  local id="$1" key="$2"
  local f
  f="$(state_file "$id")"
  [ -f "$f" ] || return 1
  python3 -c "import sys,json; d=json.load(open('$f')); print(d.get('$key',''))" 2>/dev/null
}

state_set() {
  local id="$1" key="$2" val="$3"
  local f
  f="$(state_file "$id")"
  python3 -c "
import sys,json,os
f='$f'
d={}
if os.path.exists(f):
    try: d=json.load(open(f))
    except: pass
d['$key']='''${val}'''
json.dump(d, open(f,'w'), indent=2)
" 2>/dev/null
}

state_done() {
  local id="$1" step="$2"
  state_set "$id" "step_${step}" "done"
}

state_is_done() {
  local id="$1" step="$2"
  [ "$(state_get "$id" "step_${step}")" = "done" ]
}

curl_stand() {
  curl -sk --max-time 8 "$STAND_URL$1" 2>/dev/null
}

# ── проверки окружения ───────────────────────────────────────────────────

check_prerequisites() {
  say "Проверяю окружение…"
  if ! which adb >/dev/null 2>&1; then
    die "adb не найден. Установи: brew install android-platform-tools"
  fi
  ok "adb найден: $(which adb)"

  if ! which python3 >/dev/null 2>&1; then
    die "python3 не найден"
  fi
  ok "python3 найден"

  if ! which curl >/dev/null 2>&1; then
    die "curl не найден"
  fi
  ok "curl найден"

  # скрипты station-setup
  for f in yandex-noupdate.sh patch-quasar-cfg-adbd.sh S98adbd doh-block.sh; do
    if [ ! -f "${STATION_SETUP_DIR}/${f}" ]; then
      die "Нет ${STATION_SETUP_DIR}/${f} — положи station-setup/ рядом со скриптом"
    fi
  done
  ok "station-setup/ на месте"

  # секреты (LITELLM_API_KEY, AGENT_ADMIN_TOKEN) — из env-файла
  if [ -f "${HOME}/.station-ready.env" ]; then
    # shellcheck disable=SC1090
    source "${HOME}/.station-ready.env"
  fi
  # ключ LiteLLM нужен, если идём напрямую ИЛИ агент без admin-токена
  if [ -z "${LITELLM_API_KEY}" ] && { [ "${USE_AGENT}" != "1" ] || [ -z "${AGENT_ADMIN_TOKEN}" ]; }; then
    die "LITELLM_API_KEY не задан. export LITELLM_API_KEY=… или положи в ~/.station-ready.env"
  fi
  [ -n "${LITELLM_API_KEY}" ] && ok "LITELLM_API_KEY задан"
  if [ "${USE_AGENT}" = "1" ]; then
    if [ -n "${AGENT_ADMIN_TOKEN}" ]; then
      ok "LLM-маршрут: агент ${AGENT_SERVICE} (модель ${AGENT_MODEL}); ключ колонки выпускается автоматически"
    else
      warn "AGENT_ADMIN_TOKEN не задан → колонка пойдёт напрямую в LiteLLM"
    fi
  fi
  echo
}

# ── ШАГ 0: проверка стенда и DNS ─────────────────────────────────────────

step_stand() {
  say "ШАГ 0. Проверка стенда и DNS…"
  echo

  # 1) стенд отвечает? /get_sync_info
  say "Проверяю стенд ${STAND_URL}..."
  local sync_json
  sync_json="$(curl_stand "/get_sync_info")"
  if [ -z "$sync_json" ]; then
    echo
    err "Стенд ${STAND_URL} НЕ отвечает на /get_sync_info."
    echo "  Подними стенд на .23:"
    echo "    ssh 192.168.88.23 'cd ~/lite-kit && ./start.sh'"
    echo "  Или проверь автозапуск: sudo launchctl kickstart -k system/ru.yaroslav.lite-kit"
    echo
    die "Стенд не отвечает — дальше нельзя."
  fi

  local adbd_ok
  adbd_ok="$(echo "$sync_json" | python3 -c "
import sys,json
d=json.load(sys.stdin)
c=d.get('config',{})
dc=c.get('device_config',{}) if isinstance(c,dict) else {}
adbd=dc.get('adbd',{})
print('true' if adbd.get('remoteActivation')==True else 'false')
" 2>/dev/null)"

  if [ "$adbd_ok" != "true" ]; then
    err "Стенд отвечает, но adbd.remoteActivation НЕ true в /get_sync_info."
    echo "  На хосте стенда: touch ~/lite-kit/run/sync_proxy && ./start.sh"
    die "Без adbd в конфиге колонка не получит доступ."
  fi
  ok "get_sync_info: adbd.remoteActivation=true"

  # 2) DNS: quasar-домены резолвятся в стенд
  say "Проверяю DNS (через ${DNS_RESOLVER})…"
  local dns_all_ok=true
  for domain in $QUASAR_DOMAINS; do
    local resolved
    resolved="$(dig +short "@${DNS_RESOLVER}" "$domain" 2>/dev/null || echo '')"
    if echo "$resolved" | grep -qF "$STAND_HOST"; then
      ok "  ${domain} → ${STAND_HOST}"
    else
      err "  ${domain} → ${resolved:-НЕ резолвится} (должен → ${STAND_HOST})"
      dns_all_ok=false
    fi
  done

  if ! $dns_all_ok; then
    echo
    err "DNS не ведёт quasar-домены на стенд."
    echo "  Пропиши на роутере/промежуточном резолвере форвард:"
    echo "    quasar.yandex.net → ${STAND_HOST}"
    echo "    quasar.yandex.ru → ${STAND_HOST}"
    echo "    scbh.yandex.net  → ${STAND_HOST}"
    echo "  DHCP сети уже выдаёт DNS ${DNS_RESOLVER} — проверь что он жив."
    die "DNS не настроен."
  fi
  ok "DNS: все quasar-домены → ${STAND_HOST}"

  # 3) Прошивка на стенде: проверяем для каждой известной платформы
  say "Проверяю прошивки на стенде…"
  local platforms_found=""
  for plat in yandexmini_2 yandexmidi; do
    local upd_json
    upd_json="$(curl_stand "/check_updates?device_id=LP0000000000000SETUP&platform=${plat}&version=0.0.0.1")"
    local has_ver
    has_ver="$(echo "$upd_json" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    if d.get('hasUpdate') and d.get('version','').strip():
        print(d['version'].strip())
except: pass
" 2>/dev/null)"
    if [ -n "$has_ver" ]; then
      ok "  ${plat} → прошивка ${has_ver} на стенде"
      platforms_found="${platforms_found} ${plat}"
    else
      warn "  ${plat} → прошивки НЕТ на стенде (firmware/${plat}/)"
    fi
  done

  if [ -z "$platforms_found" ]; then
    die "На стенде нет ни одной прошивки. Положи образы в firmware/yandexmini_2/ и firmware/yandexmidi/"
  fi

  echo
  say "Стенд и DNS — порядок. Можно работать."
  echo
}

# ── ШАГ 1: сброс ─────────────────────────────────────────────────────────

step_reset() {
  local id="$1"
  state_is_done "$id" reset && { say "ШАГ 1. Сброс — уже сделан, пропускаю."; echo; return 0; }

  echo
  say "ШАГ 1. Сброс к заводским настройкам"
  echo
  echo "  Сделай руками:"
  echo "  1. Обесточь колонку (вынь из розетки)."
  echo "  2. Зажми кнопку микрофона (на верхней панели)."
  echo "  3. Не отпуская кнопку, подай питание."
  echo "  4. Держи 10-15 секунд."
  echo "  5. Когда подсветка мигнёт И голос ск��жет о сбросе — отпусти."
  echo
  ask "Готово? Нажми Enter…"
  read -r _
  state_done "$id" reset
  ok "Сброс — ОК."
  echo
}

# ── ШАГ 2: Wi-Fi ─────────────────────────────────────────────────────────

step_wifi() {
  local id="$1"
  state_is_done "$id" wifi && { say "ШАГ 2. Wi-Fi — уже сделан, пропускаю."; echo; return 0; }

  echo
  say "ШАГ 2. Привязка и Wi-Fi"
  echo
  echo "  В приложении «Дом с Алисой» (или «Яндекс»):"
  echo "  1. Добавь колонку заново."
  echo "  2. Дай ей твой Wi-Fi."
  echo "  3. Дождись когда колонка скажет «я в сети» / «готово»."
  echo
  echo "  Важно: сеть должна выдавать DNS ${DNS_RESOLVER} (или роутер"
  echo "  форвардит quasar.yandex.* → ${STAND_HOST})."
  echo "  Скрипт проверил DNS перед стартом — если колонка в этой же"
  echo "  сети, она пойдёт на стенд."
  echo
  ask "Колонка в сети? Нажми Enter…"
  read -r _
  state_done "$id" wifi
  ok "Wi-Fi — ОК."
  echo
}

# ── ШАГ 3: жду колонку на стенде ─────────────────────────────────────────

discover_column() {
  local id="$1"
  local timeout="${2:-600}"

  echo
  say "ШАГ 3. Жду колонку на стенде…"
  echo "  (колонка в фазе настройки стучит /generate_204 на стенд —"
  echo "   по этому сигналу и найдём, до ${timeout} секунд)"

  local deadline
  deadline=$(($(date +%s) + timeout))
  local found_ip=""
  local found_mac=""
  local found_platform=""

  while [ "$(date +%s)" -lt "$deadline" ]; do
    local clients_json
    clients_json="$(curl_stand "/recent_clients" 2>/dev/null)"

    if [ -z "$clients_json" ]; then
      sleep 5
      continue
    fi

    # ищем свежий generate_204 с MAC Яндекса (или с любым MAC если нет OUI)
    local best
    best="$(echo "$clients_json" | python3 -c "
import sys,json,time
try:
    d=json.load(sys.stdin)
except:
    sys.exit(1)
now=time.time()
clients=d.get('clients',[])
# фильтр: свежие (<120с), не localhost, generate_204 в приоритете
candidates=[]
for c in clients:
    if c.get('ip','').startswith('127.'): continue
    if c.get('ip','').startswith('0.'): continue
    age=now-c.get('ts',0)
    if age>120: continue
    if '${TARGET_MAC}' and c.get('mac','').lower()!='${TARGET_MAC}': continue
    score=0
    if 'generate_204' in c.get('path',''): score+=10
    if c.get('mac','').lower().startswith('$YANDEX_OUI'): score+=5
    if c.get('platform',''): score+=3
    candidates.append((score, age, c))
candidates.sort(key=lambda x: (-x[0], x[1]))
if candidates:
    c=candidates[0][2]
    print(f'{c[\"ip\"]}|{c.get(\"mac\",\"\")}|{c.get(\"platform\",\"\")}|{c.get(\"path\",\"\")}')
" 2>/dev/null)"

    if [ -n "$best" ]; then
      found_ip="${best%%|*}"
      local rest="${best#*|}"
      found_mac="${rest%%|*}"
      rest="${rest#*|}"
      found_platform="${rest%%|*}"
      echo
      ok "Колонка найдена:"
      ok "  IP       : ${found_ip}"
      ok "  MAC      : ${found_mac:-пока не известен}"
      ok "  Платформа: ${found_platform:-пока не известна (generate_204)}"
      echo
      break
    fi

    # прогресс каждые 30с
    local elapsed=$(($(date +%s) + timeout - deadline))
    if [ $((elapsed % 30)) -lt 5 ]; then
      echo -n "."
    fi
    sleep 5
  done

  if [ -z "$found_ip" ]; then
    echo
    err "Колонка не появилась на стенде за ${timeout} с."
    echo "  Проверь:"
    echo "  - Wi-Fi та же сеть? (колонка получает DNS ${DNS_RESOLVER}?)"
    echo "  - Стенд жив? curl -sk ${STAND_URL}/get_sync_info"
    echo "  - Сброс точно сделан?"
    echo
    ask "Enter — попробовать ещё раз (ждать ещё ${timeout} с), Ctrl-C — выход."
    read -r _
    discover_column "$id" "$timeout"
    return $?
  fi

  state_set "$id" "ip" "$found_ip"
  state_set "$id" "mac" "$found_mac"
  state_set "$id" "platform" "$found_platform"

  # если платформа неизвестна (только generate_204) — спросим позже,
  # после того как колонка доедет до get_sync_info
  if [ -z "$found_platform" ] || [ "$found_platform" = "unknown" ]; then
    warn "Платформа пока не определена — узнаю после того как колонка получит конфиг."
  fi

  return 0
}

# ── эвристика: ip по mac через /recent_clients ─────────────────────────

resolve_ip_by_mac() {
  local mac="$1"
  local clients_json
  clients_json="$(curl_stand "/recent_clients")"
  [ -z "$clients_json" ] && return 1

  echo "$clients_json" | python3 -c "
import sys,json,time
d=json.load(sys.stdin)
now=time.time()
mac='${mac}'.lower()
for c in sorted(d.get('clients',[]), key=lambda x: -(x.get('ts',0))):
    if c.get('mac','').lower()==mac and now-c.get('ts',0)<120:
        print(c['ip'])
        break
" 2>/dev/null
}

# ── сброс adb-сервера (после долгого ожидания) ────────────────────────

adb_reset() {
  adb disconnect 2>/dev/null || true
  adb kill-server 2>/dev/null || true
  sleep 1
  adb start-server 2>/dev/null || true
}

# ── ШАГ 4: OTA — жду прошивку ────────────────────────────────────────────

wait_for_ota() {
  local id="$1"
  local ip="$2"
  local platform="$3"
  local timeout="${4:-900}"

  echo
  say "ШАГ 4. OTA — жду прошивку…"

  # узнаём целевую версию у стенда
  local target_ver
  target_ver="$(curl_stand "/check_updates?device_id=LP0000000000000SETUP&platform=${platform}&version=0.0.0.1" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(d.get('version','').strip() if d.get('hasUpdate') else '')
" 2>/dev/null)"

  if [ -z "$target_ver" ]; then
    die "Стенд не отдаёт прошивку для платформы ${platform}. Проверь firmware/${platform}/ на стенде."
  fi

  say "Целевая прошивка: ${target_ver} (платформа ${platform})"
  say "Жду, пока колонка сама скачает и поставит (обычно 3-10 минут)…"
  echo "  Не выключай колонку. Скрипт сам поймает момент когда она перезагрузится."

  local deadline
  deadline=$(($(date +%s) + timeout))
  local done=false
  local attempt=0

  while [ "$(date +%s)" -lt "$deadline" ]; do
    attempt=$((attempt + 1))

    # пере-резолвим IP по MAC (колонка могла сменить адрес после OTA)
    local mac
    mac="$(state_get "$id" "mac")"
    if [ -n "$mac" ]; then
      local fresh_ip
      fresh_ip="$(resolve_ip_by_mac "$mac")"
      if [ -n "$fresh_ip" ] && [ "$fresh_ip" != "$ip" ]; then
        say "Колонка переехала: ${ip} → ${fresh_ip}"
        ip="$fresh_ip"
        state_set "$id" "ip" "$ip"
      fi
    fi

    # пробуем adb connect
    if [ $((attempt % 3)) -eq 1 ] || [ "$attempt" -eq 1 ]; then
      adb_reset
    fi
    local adb_out
    adb_out="$(adb connect "${ip}:5555" 2>&1)"
    if echo "$adb_out" | grep -qE "connected to|already connected"; then
      # adb жив — проверяем root и версию
      local root_id
      root_id="$(adb -s "${ip}:5555" shell id 2>/dev/null)"
      if echo "$root_id" | grep -q "uid=0(root)"; then
        local fw_ver=""
        for f in /system/vendor/quasar/version_full /system/vendor/quasar/VERSION; do
          fw_ver="$(adb -s "${ip}:5555" shell "cat ${f} 2>/dev/null" 2>/dev/null | head -1 | tr -d '[:space:]')"
          [ -n "$fw_ver" ] && break
        done

        if echo "$fw_ver" | grep -qF "$target_ver"; then
          echo
          ok "ADB+root есть. Прошивка: ${fw_ver} = целевая ${target_ver}"
          done=true
          break
        else
          # adb есть, но версия не совпала — OTA ещё идёт
          if [ $((attempt % 6)) -eq 1 ]; then
            echo -n "."
          fi
          adb disconnect "${ip}:5555" 2>/dev/null || true
        fi
      else
        # adb есть, root нет — странно, но может быть промежуточное состояние
        adb disconnect "${ip}:5555" 2>/dev/null || true
      fi
    else
      # adb не отвечает — это нормально, OTA ещё не доехала
      if [ $((attempt % 6)) -eq 1 ]; then
        echo -n "."
      fi
    fi

    # проверяем: не появился ли get_sync_info (колонка получила конфиг стенда)
    if [ $((attempt % 10)) -eq 0 ]; then
      local sync_seen
      sync_seen="$(curl_stand "/recent_clients" | python3 -c "
import sys,json,time
d=json.load(sys.stdin)
now=time.time()
target='${ip}'
# ищем get_sync_info от нашего IP/MAC
for c in d.get('clients',[]):
    if c.get('ip')==target and 'get_sync_info' in c.get('path','') and now-c.get('ts',0)<60:
        print('yes')
        break
" 2>/dev/null)"
      if [ "$sync_seen" = "yes" ]; then
        say "Колонка получила конфиг стенда (get_sync_info) — adb включён, скоро появится…"
      fi
    fi

    sleep 5
  done

  if $done; then
    state_set "$id" "ip" "$ip"
    state_done "$id" "ota"
    # запоминаем модель по платформе
    case "$platform" in
      yandexmini_2) state_set "$id" "model" "mini" ;;
      yandexmidi)   state_set "$id" "model" "station2" ;;
      *)            state_set "$id" "model" "unknown" ;;
    esac
    return 0
  fi

  echo
  err "OTA не завершилась за ${timeout} с."
  echo "  Возможно колонка ещё ставит прошивку."
  ask "Enter — ждать ещё ${timeout} с, Ctrl-C — выход."
  read -r _
  wait_for_ota "$id" "$ip" "$platform" "$timeout"
}

# ── опред��лить платформу ──────────────────────────────────────────────────

determine_platform() {
  local id="$1"

  # форсированная платформа (--platform) — не угадываем
  if [ -n "$FORCED_PLATFORM" ]; then
    echo "$FORCED_PLATFORM"
    return 0
  fi

  # сначала из state
  local plat
  plat="$(state_get "$id" "platform")"

  # если пусто или unknown — ждём появления в /recent_clients
  if [ -z "$plat" ] || [ "$plat" = "unknown" ]; then
    say "Платформа пока неизвестна. Жду get_sync_info от колонки…"
    local ip
    ip="$(state_get "$id" "ip")"
    for _ in $(seq 1 24); do
      plat="$(curl_stand "/recent_clients" | python3 -c "
import sys,json,time
d=json.load(sys.stdin)
now=time.time()
for c in d.get('clients',[]):
    if c.get('ip')=='${ip}' and c.get('platform','').strip() and now-c.get('ts',0)<120:
        print(c['platform'].strip())
        break
" 2>/dev/null)"
      if [ -n "$plat" ] && [ "$plat" != "unknown" ]; then
        state_set "$id" "platform" "$plat"
        ok "Платформа: ${plat}"
        break
      fi
      sleep 10
    done
  fi

  # если всё ещё нет — спрашиваем
  if [ -z "$plat" ] || [ "$plat" = "unknown" ]; then
    echo
    warn "Не удалось определить модель автоматически."
    ask "Какая колонка? (mini / station2): "
    read -r model_choice
    case "$model_choice" in
      mini|min|m)     plat="yandexmini_2" ;;
      station2|s2|s)  plat="yandexmidi" ;;
      *)              plat="yandexmini_2"; warn "Не понял — беру yandexmini_2 (мини)" ;;
    esac
    state_set "$id" "platform" "$plat"
  fi

  echo "$plat"
}

# ── ШАГ 5: ADB и root ─────────────────────────────────────────────────────

step_adb_root() {
  local id="$1"
  local ip="$2"

  state_is_done "$id" adbroot && { say "ШАГ 5. ADB+root — уже есть, пропускаю."; echo; return 0; }

  echo
  say "ШАГ 5. Проверяю ADB и root…"

  adb_reset
  local out
  out="$(adb connect "${ip}:5555" 2>&1)"
  if ! echo "$out" | grep -qE "connected to|already connected"; then
    die "adb connect ${ip}:5555 не удался: ${out}"
  fi

  local id_out
  id_out="$(adb -s "${ip}:5555" shell id 2>/dev/null)"
  if ! echo "$id_out" | grep -q "uid=0(root)"; then
    err "ADB есть, но root НЕТ."
    err "  id: ${id_out}"
    die "Не та прошивка? Попробуй сбросить колонку и начать заново."
  fi

  ok "ADB+root — есть (uid=0)."
  state_set "$id" "ip" "$ip"
  state_done "$id" "adbroot"
  echo
}

# ── ШАГ 6: подготовка (noupdate + маркеры + патч + S98 + DoH) ────────────

step_persist() {
  local id="$1"
  local ip="$2"

  state_is_done "$id" persist && { say "ШАГ 6. Подготовка — уже сделана, пропускаю."; echo; return 0; }

  echo
  say "ШАГ 6. Подготовка: защита доступа + блокировка обновлений…"

  local dev="${ip}:5555"

  # загружаем скрипты на колонку
  say "Загружаю скрипты на колонку…"
  adb -s "$dev" shell "mkdir -p /data/opt" 2>/dev/null

  for f in yandex-noupdate.sh patch-quasar-cfg-adbd.sh S98adbd doh-block.sh; do
    adb -s "$dev" push "${STATION_SETUP_DIR}/${f}" "/data/opt/${f}" 2>/dev/null || die "adb push ${f} не удался"
    adb -s "$dev" shell "chmod 755 /data/opt/${f}" 2>/dev/null
  done
  ok "Скрипты на колонке."

  # 1) noupdate
  say "Блокирую обновления…"
  local noup_out
  noup_out="$(adb -s "$dev" shell "sh /data/opt/yandex-noupdate.sh 2>&1")"
  echo "$noup_out" | tail -6 | while read -r line; do [ -n "$line" ] && echo "  ${line}"; done

  local noup_status
  noup_status="$(adb -s "$dev" shell "sh /data/opt/yandex-noupdate.sh status 2>&1")"
  if echo "$noup_status" | grep -qiE "защищ|active|подмен|заглуш"; then
    ok "Обновления заблокированы."
  else
    err "Статус noupdate не подтверждён:"
    echo "$noup_status"
    die "Не удалось заблокировать обновления."
  fi

  # 2) патч quasar.cfg
  say "Патчу quasar.cfg (deactivate → /bin/true)…"
  adb -s "$dev" shell "sh /data/opt/patch-quasar-cfg-adbd.sh 2>&1" | tail -3 | while read -r line; do [ -n "$line" ] && echo "  ${line}"; done

  local cfg_cnt
  cfg_cnt="$(adb -s "$dev" shell "grep -o '/bin/true' /system/vendor/quasar/quasar.cfg 2>/dev/null | wc -l" 2>/dev/null | tr -d '[:space:]')"
  if [ "${cfg_cnt:-0}" -ge 2 ]; then
    ok "quasar.cfg: deactivate = /bin/true (${cfg_cnt} вхождений)."
  else
    err "Патч quasar.cfg не подтвердился (вхождений /bin/true: ${cfg_cnt:-0})."
  fi

  # 3) S98adbd в /etc/init.d
  say "Ставлю автозапуск S98adbd…"
  adb -s "$dev" shell "mount -o remount,rw / 2>/dev/null" 2>/dev/null
  adb -s "$dev" push "${STATION_SETUP_DIR}/S98adbd" "/etc/init.d/S98adbd" 2>/dev/null || warn "adb push S98adbd не удался"
  adb -s "$dev" shell "chmod 755 /etc/init.d/S98adbd; mount -o remount,ro / 2>/dev/null" 2>/dev/null
  ok "S98adbd установлен."

  # 4) блок DoH
  say "Блокирую обходной DoH…"
  adb -s "$dev" shell "sh /data/opt/doh-block.sh 2>&1" | tail -3 | while read -r line; do [ -n "$line" ] && echo "  ${line}"; done

  local doh_cnt
  doh_cnt="$(adb -s "$dev" shell "iptables -S OUTPUT 2>/dev/null | grep -c REJECT" 2>/dev/null | tr -d '[:space:]')"
  if [ "${doh_cnt:-0}" -ge 4 ]; then
    ok "DoH-адр��са заблокированы (${doh_cnt} правил REJECT)."
  else
    warn "Блок DoH не подтвердился (правил REJECT: ${doh_cnt:-0})."
  fi

  # 5) маркеры + chattr +i (обе схемы имён)
  say "Ставлю маркеры ADB и защищаю (chattr +i)…"
  adb -s "$dev" shell "touch /data/quasar/activate_adb_quasmodrom /data/quasar/activate_network_adb /data/quasar_activate_adb_quasmodrom /data/quasar_activate_network_adb 2>/dev/null"
  adb -s "$dev" shell "chattr +i /data/quasar/activate_adb_quasmodrom /data/quasar/activate_network_adb 2>/dev/null" || warn "chattr +i не сработал на /data/quasar/ (может не быть в busybox)"
  adb -s "$dev" shell "chattr +i /data/quasar_activate_adb_quasmodrom /data/quasar_activate_network_adb 2>/dev/null" || true

  # проверка
  local lsattr_out
  lsattr_out="$(adb -s "$dev" shell "lsattr /data/quasar/activate_* /data/quasar_activate_* 2>/dev/null" 2>/dev/null)"
  if echo "$lsattr_out" | grep -qE "[-]*i[-]*"; then
    ok "Маркеры защищены (chattr +i)."
  else
    warn "Маркеры созданы, но chattr +i не подтвердился. Защита держится на quasar.cfg."
  fi

  # 6) перезагрузка
  say "Перезагружаю колонку…"
  adb -s "$dev" reboot 2>/dev/null || true
  sleep 12

  say "Жду возврата ADB после перезагрузки (до 120 с)…"
  local deadline
  deadline=$(($(date +%s) + 120))
  local back=false

  while [ "$(date +%s)" -lt "$deadline" ]; do
    # пере-резолв IP
    local mac
    mac="$(state_get "$id" "mac")"
    if [ -n "$mac" ]; then
      local fresh_ip
      fresh_ip="$(resolve_ip_by_mac "$mac")"
      [ -n "$fresh_ip" ] && ip="$fresh_ip" && dev="${ip}:5555"
    fi

    adb_reset
    if adb connect "${ip}:5555" 2>&1 | grep -qE "connected to|already connected"; then
      local rid
      rid="$(adb -s "${ip}:5555" shell id 2>/dev/null)"
      if echo "$rid" | grep -q "uid=0(root)"; then
        back=true
        break
      fi
    fi
    sleep 5
  done

  if ! $back; then
    err "Колонка не вернулась после перезагрузки."
    ask "Enter — попробовать ещё раз, Ctrl-C — выход."
    read -r _
    # рекурсивно — пробуем снова (маркеры уже стоят, S98 должен поднять adb)
    step_persist "$id" "$ip"
    return $?
  fi

  ok "ADB+root поднялись сами после перезагрузки."

  # проверяем что слои пережили
  local ls2 cfg2 doh2
  ls2="$(adb -s "${ip}:5555" shell "lsattr /data/quasar/activate_* /data/quasar_activate_* 2>/dev/null" 2>/dev/null)"
  cfg2="$(adb -s "${ip}:5555" shell "grep -o '/bin/true' /system/vendor/quasar/quasar.cfg 2>/dev/null | wc -l" 2>/dev/null | tr -d '[:space:]')"
  doh2="$(adb -s "${ip}:5555" shell "iptables -S OUTPUT 2>/dev/null | grep -c REJECT" 2>/dev/null | tr -d '[:space:]')"

  local survived=true
  echo "$ls2" | grep -qE "[-]*i[-]*" || { warn "Маркеры без +i после перезагрузки."; survived=false; }
  [ "${cfg2:-0}" -ge 2 ] || { warn "quasar.cfg не патчен после перезагрузки (${cfg2:-0})."; survived=false; }
  [ "${doh2:-0}" -ge 4 ] || { warn "DoH-блок не пережил перезагрузку (${doh2:-0})."; survived=false; }

  if $survived; then
    ok "ВСЕ слои пережили перезагрузку: маркеры, cfg, DoH."
  else
    warn "Часть слоёв не пережила перезагрузку — закрепление не полное. Шаг можно повторить (идемпотентен)."
  fi

  state_set "$id" "ip" "$ip"
  state_done "$id" "persist"
  echo
}

# ── Агент: привязка колонки и выпуск ключа ────────────────────────────────
# Печатает ключ колонки (sk-station-…) в stdout; при неудаче — пусто.
# device — в формате панели/агента: <ip>-<port> (напр. 192.168.88.48-5555).
agent_bind_station() {
  local device="$1"
  local slug="${AGENT_MODEL#agent:}"
  local auth="Authorization: Bearer ${AGENT_ADMIN_TOKEN}"
  local aid sid key resp

  [ "${USE_AGENT}" = "1" ] || return 1
  [ -n "${AGENT_ADMIN_TOKEN}" ] || return 1

  # id агента по slug
  aid="$(curl -sk --max-time 8 -H "$auth" "${AGENT_SERVICE}/admin/agents" 2>/dev/null \
        | tr '}' '\n' | grep "\"slug\":\"${slug}\"" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)"
  [ -n "$aid" ] || { warn "агент ${slug} не найден в ${AGENT_SERVICE}"; return 1; }

  # существующая станция по device / создать
  sid="$(curl -sk --max-time 8 -H "$auth" "${AGENT_SERVICE}/admin/stations" 2>/dev/null \
        | tr '}' '\n' | grep "\"device\":\"${device}\"" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)"
  if [ -z "$sid" ]; then
    resp="$(curl -sk --max-time 8 -X POST -H "$auth" -H "Content-Type: application/json" \
            -d "{\"device\":\"${device}\"}" "${AGENT_SERVICE}/admin/stations" 2>/dev/null)"
    sid="$(echo "$resp" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)"
  fi
  [ -n "$sid" ] || { warn "не удалось создать станцию ${device} в агенте"; return 1; }

  # привязать агента и выпустить ключ
  curl -sk --max-time 8 -X PUT -H "$auth" -H "Content-Type: application/json" \
    -d "{\"agent_id\":${aid}}" "${AGENT_SERVICE}/admin/stations/${sid}/agent" >/dev/null 2>&1
  key="$(curl -sk --max-time 8 -X POST -H "$auth" "${AGENT_SERVICE}/admin/stations/${sid}/key" 2>/dev/null \
        | sed -n 's/.*"key":"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$key" ] && echo "$key"
}

# ── ШАГ 7: мост + голос ───────────────────────────────────────────────────

step_bridge() {
  local id="$1"
  local ip="$2"

  state_is_done "$id" bridge && { say "ШАГ 7. Мост — уже установлен, пропускаю."; echo; return 0; }

  echo
  say "ШАГ 7. Устанавливаю мост quasar-bridge + голос ermil…"

  local dev="${ip}:5555"

  # проверяем adb
  adb_reset
  adb connect "${ip}:5555" 2>/dev/null
  if ! adb -s "$dev" shell id 2>/dev/null | grep -q "uid=0(root)"; then
    die "ADB/root не доступны. Сначала шаг 6."
  fi

  # если мост уже healthy — только голос и endpoint
  local status_out
  status_out="$(adb -s "$dev" shell "sh /data/opt/quasar-bridge/app/control.sh status 2>&1" 2>/dev/null)"
  if echo "$status_out" | grep -q "Bridge healthy"; then
    ok "Мост уже healthy."

    # голос
    say "Проверяю голос…"
    adb -s "$dev" shell "printf 'voice=${BRIDGE_VOICE}\n' > /data/opt/quasar-bridge/tts.override && chmod 600 /data/opt/quasar-bridge/tts.override" 2>/dev/null
    ok "Голос: ${BRIDGE_VOICE} (tts.override)."

    # endpoint
    local ep_cnt
    ep_cnt="$(adb -s "$dev" shell "grep -o '127.0.0.1:8443/uni.ws' /system/vendor/quasar/quasar.cfg 2>/dev/null | wc -l" 2>/dev/null | tr -d '[:space:]')"
    if [ "${ep_cnt:-0}" -gt 0 ]; then
      ok "uniproxy уже переключён на мост."
    else
      say "Переключаю uniproxy на мост…"
      adb -s "$dev" shell "sh /data/opt/quasar-bridge/app/control.sh apply 2>&1" 2>/dev/null
      ok "uniproxy → 127.0.0.1:8443/uni.ws (вступит после перезагрузки)."
    fi

    state_done "$id" "bridge"
    return 0
  fi

  # архитектура
  local arch
  arch="$(adb -s "$dev" shell "uname -m 2>/dev/null" 2>/dev/null | tr -d '[:space:]')"
  case "$arch" in
    armv7*|armv8l) arch="armv7" ;;
    aarch64|arm64) arch="arm64" ;;
    *)             die "Неизвестная архитектура: ${arch}" ;;
  esac
  say "Архитектура: ${arch}"

  local asset="quasar-bridge-linux-${arch}.tar.gz"
  local tgz_path=""
  local source_label=""

  # пробуем форк-бандл
  if [ -f "${BRIDGE_FORK_DIST}/${asset}" ] && [ -s "${BRIDGE_FORK_DIST}/${asset}" ]; then
    tgz_path="${BRIDGE_FORK_DIST}/${asset}"
    source_label="форк (голос ermil)"
  else
    # фолбэк: качаем апстрим
    say "Форк-бандл не найден — качаю апстрим v${BRIDGE_VERSION} (голос будет женский, переопределю)…"
    mkdir -p "${BRIDGE_CACHE_DIR}"
    local cache_tgz="${BRIDGE_CACHE_DIR}/v${BRIDGE_VERSION}-${arch}.tar.gz"
    local cache_sha="${BRIDGE_CACHE_DIR}/v${BRIDGE_VERSION}-${arch}.tar.gz.sha256"

    local base_url="https://github.com/skrashevich/quasar-bridge/releases/download/v${BRIDGE_VERSION}"

    if [ ! -f "$cache_tgz" ] || [ ! -s "$cache_tgz" ]; then
      curl -skL --max-time 60 -o "$cache_tgz" "${base_url}/${asset}" || die "Не удалось скачать ${asset} с GitHub"
    fi
    if [ ! -f "$cache_sha" ] || [ ! -s "$cache_sha" ]; then
      curl -skL --max-time 30 -o "$cache_sha" "${base_url}/${asset}.sha256" 2>/dev/null || true
    fi
    tgz_path="$cache_tgz"
    source_label="апстрим v${BRIDGE_VERSION}"
  fi

  # sha256 сверка
  local expect actual
  if [ -f "${tgz_path}.sha256" ]; then
    expect="$(head -1 "${tgz_path}.sha256" | awk '{print $1}')"
  fi
  actual="$(shasum -a 256 "$tgz_path" | awk '{print $1}')"
  if [ -n "${expect:-}" ] && [ "$expect" != "$actual" ]; then
    die "sha256 не сошёлся! Ожидалось ${expect}, получено ${actual}"
  fi
  ok "Пакет моста: ${source_label} (sha256 ${actual:0:12}…, ${arch})"

  # LLM-маршрут: по умолчанию — через НАШЕГО агента (agent-service), как у mini.
  local llm_base="${LITELLM_LAN_URL}" llm_key="${LITELLM_API_KEY}" llm_model="${LITELLM_MODEL}"
  if [ "${USE_AGENT}" = "1" ]; then
    local agkey
    agkey="$(agent_bind_station "${ip}-5555" || true)"
    if [ -n "${agkey:-}" ]; then
      llm_base="${AGENT_LAN_URL}"; llm_key="${agkey}"; llm_model="${AGENT_MODEL}"
      ok "LLM-маршрут: агент ${AGENT_LAN_URL} (модель ${AGENT_MODEL}, ключ колонки выпущен)."
    else
      warn "агент недоступен → маршрут напрямую в LiteLLM (${LITELLM_LAN_URL})."
    fi
  fi

  # готовим runtime.env
  local runtime_env
  runtime_env="QUASAR_MODE=\"hybrid\"
QUASAR_LLM_BASE_URL=\"${llm_base}\"
QUASAR_LLM_API_KEY=\"${llm_key}\"
QUASAR_LLM_MODEL=\"${llm_model}\"
QUASAR_LLM_API=\"chat_completions\""

  # ставим
  say "Устанавливаю мост на колонку…"
  local stage="/data/opt/.bridge-install"
  adb -s "$dev" shell "rm -rf ${stage}; mkdir -p ${stage}/pkg && chmod 700 ${stage}" 2>/dev/null

  # проверка свободн��го места
  local free_kb
  free_kb="$(adb -s "$dev" shell "df -k /data | tail -1" 2>/dev/null | awk '{print $4}' | tr -d '[:space:]')"
  if [ -n "${free_kb:-}" ] && [ "${free_kb:-0}" -lt 45000 ]; then
    die "На /data колонки свободно ~$((free_kb / 1024)) МБ — для установки нужно ≥45 МБ."
  fi

  adb -s "$dev" push "$tgz_path" "${stage}/pkg.tar.gz" 2>/dev/null || die "adb push пакета не удался"

  # runtime.env временный файл (с ключом — удалим после пуша)
  local tmp_env
  tmp_env="$(mktemp /tmp/station-ready-runtime.XXXXXX)"
  echo "$runtime_env" > "$tmp_env"
  adb -s "$dev" push "$tmp_env" "${stage}/runtime.env" 2>/dev/null || die "adb push runtime.env не удался"
  rm -f "$tmp_env"

  # install
  local install_script
  install_script="cd ${stage} || exit 2
echo '${actual}  pkg.tar.gz' | sha256sum -c - >/dev/null 2>&1 || { echo 'sha256 на колонке не сошёлся'; rm -rf ${stage}; exit 9; }
gzip -dc pkg.tar.gz | tar -x -C pkg || { echo 'распаковка не удалась'; rm -rf ${stage}; exit 3; }
rm -f pkg.tar.gz
test -f pkg/install.sh || { echo 'в пакете нет install.sh'; rm -rf ${stage}; exit 4; }
mkdir -p /data/opt/quasar-bridge && chmod 700 /data/opt/quasar-bridge
[ -e /data/opt/quasar-bridge/runtime.env ] || cp runtime.env /data/opt/quasar-bridge/runtime.env
chmod 600 /data/opt/quasar-bridge/runtime.env
sh pkg/install.sh 2>&1; rc=\$?
cd /; rm -rf ${stage}
exit \$rc"

  local inst_out
  inst_out="$(adb -s "$dev" shell "$install_script" 2>&1)"
  local inst_rc=$?

  if [ $inst_rc -ne 0 ]; then
    echo "$inst_out" | tail -10
    die "install.sh завершился с ошибкой (rc=${inst_rc})."
  fi

  # проверка
  sleep 3
  local st2
  st2="$(adb -s "$dev" shell "sh /data/opt/quasar-bridge/app/control.sh status 2>&1" 2>/dev/null)"
  local pid
  pid="$(echo "$st2" | grep -o 'PID [0-9]*' | awk '{print $2}')"
  if [ -n "$pid" ]; then
    ok "Мост healthy (PID ${pid})."
  else
    err "Мост установлен, но не стал healthy:"
    echo "$st2" | tail -5
    die "Проверь service.log на колонке."
  fi

  # LiteLLM-роут не принимает chat_template_kwargs (мост шлёт его всегда) → 400.
  # Нейтрализуем через llm_chat_parameters: null удаляет ключ, reasoning_effort=none гасит thinking.
  cfjson="/data/opt/quasar-bridge/config.json"
  if ! adb -s "$dev" shell "grep -q llm_chat_parameters ${cfjson}" 2>/dev/null; then
    adb -s "$dev" shell "cp -p ${cfjson} ${cfjson}.bak-llm" 2>/dev/null
    adb -s "$dev" shell "sed -i 's/^  \"mode\":/  \"llm_chat_parameters\": {\"chat_template_kwargs\": null, \"reasoning_effort\": \"none\"},\n  \"mode\":/' ${cfjson}" 2>/dev/null
    adb -s "$dev" shell "sh /data/opt/quasar-bridge/app/control.sh restart" >/dev/null 2>&1
    ok "config.json: chat_template_kwargs нейтрализован (llm_chat_parameters)."
  fi

  # голос
  adb -s "$dev" shell "printf 'voice=${BRIDGE_VOICE}\n' > /data/opt/quasar-bridge/tts.override && chmod 600 /data/opt/quasar-bridge/tts.override" 2>/dev/null
  ok "Голос: ${BRIDGE_VOICE} (tts.override)."

  # uniproxy → мост
  local ep_cnt2
  ep_cnt2="$(adb -s "$dev" shell "grep -o '127.0.0.1:8443/uni.ws' /system/vendor/quasar/quasar.cfg 2>/dev/null | wc -l" 2>/dev/null | tr -d '[:space:]')"
  if [ "${ep_cnt2:-0}" -gt 0 ]; then
    ok "uniproxy уже на мосте."
  else
    say "Переключаю uniproxy на мост…"
    adb -s "$dev" shell "sh /data/opt/quasar-bridge/app/control.sh apply 2>&1" 2>/dev/null
    local ep_cnt3
    ep_cnt3="$(adb -s "$dev" shell "grep -o '127.0.0.1:8443/uni.ws' /system/vendor/quasar/quasar.cfg 2>/dev/null | wc -l" 2>/dev/null | tr -d '[:space:]')"
    if [ "${ep_cnt3:-0}" -gt 0 ]; then
      ok "uniproxy → 127.0.0.1:8443/uni.ws."
    else
      warn "Не удалось переключить uniproxy на мост — сделай вручную: adb shell sh /data/opt/quasar-bridge/app/control.sh apply"
    fi
  fi

  state_done "$id" "bridge"
  echo
}

# ── ШАГ 8: финал ──────────────────────────────────────────────────────────

step_finish() {
  local id="$1"
  local ip="$2"

  echo
  say "ШАГ 8. ГОТОВО"
  echo

  local mac model platform
  mac="$(state_get "$id" "mac")"
  model="$(state_get "$id" "model")"
  platform="$(state_get "$id" "platform")"

  case "$model" in
    mini)     model="Яндекс Станция Мини 2" ;;
    station2) model="Яндекс Станция 2" ;;
    *)        model="Яндекс Станция (${platform:-неизвестно})" ;;
  esac

  echo "  Колонка готова к спариванию с панелью:"
  echo
  echo "    Модель : ${model}"
  echo "    IP     : ${ip}"
  echo "    MAC    : ${mac:-не определён}"
  echo "    ADB    : порт 5555, root"
  echo "    Мост   : quasar-bridge, голос ${BRIDGE_VOICE}"
  echo "    Обновления : заблокированы"
  echo "    Доступ : защищён (маркеры, cfg, DoH)"
  echo
  echo "  Теперь открой панель и добавь колонку:"
  echo "    http://192.168.88.207:3110"
  echo "  Мастер в панели увидит готовую колонку и пропустит"
  echo "  шаги ��астройки."
  echo
}

# ── MAIN ──────────────────────────────────────────────────────────────────

main() {
  echo
  echo "${BOLD}=== station-ready.sh ===${RESET}"
  echo "  Доводит Яндекс Станцию до «готова к панели»"
  echo "  Стенд: ${STAND_URL}"
  echo "  DNS-резолвер: ${DNS_RESOLVER}"
  echo

  # аргументы: --target MAC, --platform PLAT
  while [ $# -gt 0 ]; do
    case "$1" in
      --target)   TARGET_MAC="$(echo "${2:-}" | tr 'A-F' 'a-f')"; shift 2 ;;
      --target=*) TARGET_MAC="$(echo "${1#*=}" | tr 'A-F' 'a-f')"; shift ;;
      --platform)   FORCED_PLATFORM="${2:-}"; shift 2 ;;
      --platform=*) FORCED_PLATFORM="${1#*=}"; shift ;;
      -h|--help)
        echo "  Использование: $0 [--target MAC] [--platform yandexmini_2|yandexmidi]"
        exit 0 ;;
      *) warn "неизвестный аргумент: $1"; shift ;;
    esac
  done
  [ -n "$TARGET_MAC" ] && say "Цель по MAC: ${TARGET_MAC}"
  [ -n "$FORCED_PLATFORM" ] && say "Платформа задана: ${FORCED_PLATFORM}"

  check_prerequisites

  # идентификатор для state: tmp-ключ, пока не узнаем IP; при --target — привязка к MAC
  local id="new-column"
  [ -n "$TARGET_MAC" ] && id="mac-${TARGET_MAC//:/}"
  local ip=""
  local platform=""

  # Шаг 0 (всегда)
  step_stand

  # Шаг 1 (руки)
  step_reset "$id"

  # Шаг 2 (руки)
  step_wifi "$id"

  # Шаг 3 (авто)
  discover_column "$id"
  ip="$(state_get "$id" "ip")"
  [ -z "$ip" ] && die "IP колонки не определён."

  # меняем id на IP для state-файла (при --target оставляем привязку к MAC)
  [ -z "$TARGET_MAC" ] && id="$ip"

  # определяем платформу
  platform="$(determine_platform "$id")"
  [ -z "$platform" ] && die "Не удалось определить платформу."

  # Шаг 4
  wait_for_ota "$id" "$ip" "$platform"
  ip="$(state_get "$id" "ip")"

  # Шаг 5
  step_adb_root "$id" "$ip"

  # Шаг 6
  step_persist "$id" "$ip"
  ip="$(state_get "$id" "ip")"

  # Шаг 7
  step_bridge "$id" "$ip"

  # Шаг 8
  step_finish "$id" "$ip"
}

main "$@"
