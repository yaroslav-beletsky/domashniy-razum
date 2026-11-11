#!/usr/bin/env bash
#
# fetch-needed.sh — скачивает «нужный набор» прошивок Станций с чужого зеркала:
# по ОДНОЙ последней версии на каждую из 23 платформ (список — needed-latest.tsv).
#
# Куда кладёт: <dir>/<platform>/<version>.zip  (dir по умолчанию ./firmware).
# Идемпотентно: файл нужного размера пропускается; недокачанный/битый — перекачивается.
# После каждого файла сверяет размер с ожидаемым size_bytes и печатает итог.
#
# Использование:
#   ./firmware/fetch-needed.sh                   # качает в ./firmware
#   ./firmware/fetch-needed.sh /volume2/zvony    # качает в другую папку
#   TSV=/путь/needed-latest.tsv ./fetch-needed.sh
#
# Если с домашней сети зеркало виснет на ~10784 байт (см. docs/firmware-download.md),
# качай через туннель до хоста в Амстердаме:
#   ssh -f -N -D 1081 root@dev-desktop-ams
#   SOCKS=127.0.0.1:1081 ./firmware/fetch-needed.sh
#
# Примечание: зеркало отдаёт файлы обычным SimpleHTTP и НЕ поддерживает Range,
# поэтому частично скачанный файл перекачивается целиком (а не «докачивается в хвост»).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TSV="${TSV:-$SCRIPT_DIR/needed-latest.tsv}"
OUT="${1:-./firmware}"

if [ ! -f "$TSV" ]; then
    echo "нет файла списка: $TSV" >&2
    exit 2
fi

mkdir -p "$OUT"
OUT_ABS="$(cd "$OUT" && pwd)"

CURL_OPTS=( -L --retry 5 -C - --fail --progress-bar
            --connect-timeout 30 --speed-limit 1000 --speed-time 30 )
if [ -n "${SOCKS:-}" ]; then
    CURL_OPTS+=( --socks5-hostname "$SOCKS" )
fi

n_ok=0; n_skip=0; n_fail=0
bytes_ok=0; bytes_total=0
fail_list=""

echo "Список: $TSV"
echo "Куда:   $OUT_ABS"
[ -n "${SOCKS:-}" ] && echo "Прокси: socks5h://$SOCKS"
echo "---"

while IFS=$'\t' read -r platform version size url; do
    [ -z "${platform:-}" ] && continue
    bytes_total=$((bytes_total + size))
    dest="$OUT_ABS/$platform/$version.zip"
    mkdir -p "$OUT_ABS/$platform"

    if [ -f "$dest" ]; then
        cur="$(wc -c < "$dest" | tr -d ' ')"
        if [ "$cur" = "$size" ]; then
            echo "skip  $platform  $version  ($cur B)"
            n_skip=$((n_skip + 1)); bytes_ok=$((bytes_ok + size))
            continue
        fi
        echo "redo  $platform  $version  (есть $cur B, нужно $size B) — перекачиваю"
        rm -f "$dest"
    fi

    echo "get   $platform  $version  ($size B)"
    curl "${CURL_OPTS[@]}" -o "$dest" "$url" || echo "      curl вернул ошибку"

    if [ -f "$dest" ]; then
        cur="$(wc -c < "$dest" | tr -d ' ')"
    else
        cur=0
    fi
    if [ "$cur" = "$size" ]; then
        echo "ok    $platform  $version  ($cur B)"
        n_ok=$((n_ok + 1)); bytes_ok=$((bytes_ok + size))
    else
        echo "FAIL  $platform  $version  ($cur B != $size B)"
        n_fail=$((n_fail + 1)); fail_list="$fail_list $platform/$version"
    fi
done < "$TSV"

echo "---"
echo "скачано: $n_ok   пропущено: $n_skip   ошибок: $n_fail"
echo "объём:   $(echo "$bytes_ok" | awk '{printf "%.2f GB", $1/1000000000}') из $(echo "$bytes_total" | awk '{printf "%.2f GB", $1/1000000000}')"
if [ "$n_fail" -gt 0 ]; then
    echo "неполные:$fail_list"
    echo "запусти скрипт ещё раз — недокачанные перекачаются"
    exit 1
fi
echo "всё на месте."
