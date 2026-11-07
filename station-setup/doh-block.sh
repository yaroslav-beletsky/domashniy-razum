#!/bin/sh
# doh-block.sh — вырезаем у колонки зашитый обходной DoH (fragment).
#
# Это тот же набор правил, что стоит в начале /etc/init.d/S98adbd start.
# Здесь он вынесен отдельно, чтобы можно было применить/снять руками, не
# трогая автозапуск.
#
# Зачем:
#   Прошивка умеет разрешать quasar.yandex.net через свой жёстко зашитый
#   DNS-over-HTTPS (1.1.1.1), минуя наш стенд. Тогда на boot-sync приходит
#   настоящий облачный конфиг без adbd, и maind вызывает deactivate, который
#   сносит маркеры ADB (см. docs/how-we-took-over.md, раздел 4).
#   REJECT на эти адреса заставляет все имена идти через unbound -> AdGuard ->
#   lite-kit, то есть через стенд.
#
# Важно: правило добавляется в цепочку OUTPUT, policy по умолчанию ACCEPT,
# таблица filter — единственная, что нужна.
#
#   sh doh-block.sh          # включить
#   sh doh-block.sh status   # показать
#   sh doh-block.sh off      # снять (вернуть DoH как был)
set -u

HOSTS="1.1.1.1 1.0.0.1 8.8.8.8 8.8.4.4"

need_root() { [ "$(id -u)" = 0 ] || { echo "нужен root"; exit 1; }; }

on() {
	need_root
	for ip in $HOSTS; do
		iptables -C OUTPUT -d "$ip" -j REJECT 2>/dev/null || \
			iptables -A OUTPUT -d "$ip" -j REJECT
	done
	echo "DoH заблокирован: $HOSTS"
}

off() {
	need_root
	for ip in $HOSTS; do
		while iptables -C OUTPUT -d "$ip" -j REJECT 2>/dev/null; do
			iptables -D OUTPUT -d "$ip" -j REJECT
		done
	done
	echo "DoH-блок снят"
}

status() {
	for ip in $HOSTS; do
		if iptables -C OUTPUT -d "$ip" -j REJECT 2>/dev/null; then
			echo "  $ip -> REJECT"
		else
			echo "  $ip -> открыт"
		fi
	done
}

case "${1:-on}" in
	on)     on ;;
	off)    off ;;
	status) status ;;
	*) echo "usage: $0 {on|off|status}"; exit 1 ;;
esac
