#!/usr/bin/env bash
# Сборка форка quasar-bridge (v0.7.4 + патч QUASAR_TTS_VOICE) под Яндекс Станцию Мини 2 (linux/arm64).
# Результат: dist/quasar-bridge-arm64 (готовый бинарь, UPX) и dist/quasar-bridge-linux-arm64.tar.gz (штатный пакет).
# Нужны: go (сам подтянет toolchain из go.mod), python3, upx (brew install upx).
set -euo pipefail
cd "$(dirname "$0")/src"
go test ./internal/bridge/ -run 'TestNewTtsGenerateVoice|TestTtsOverride|TestReadProbeList|TestParseTtsCases|TestSplitTtsStyle|TestCleanSpeech' -count=1
go vet ./cmd/quasar-bridge/ ./internal/bridge/
rm -rf ../dist && mkdir -p ../dist
python3 scripts/build-speaker-package.py --arch arm64 --tag v0.7.4 --upx --output ../dist/quasar-bridge-linux-arm64.tar.gz
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
tar -xzf ../dist/quasar-bridge-linux-arm64.tar.gz -C "$tmp" bin/quasar-bridge
cp "$tmp/bin/quasar-bridge" ../dist/quasar-bridge-arm64
file ../dist/quasar-bridge-arm64
shasum -a 256 ../dist/quasar-bridge-arm64
