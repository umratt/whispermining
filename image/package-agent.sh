#!/bin/bash
# Agent güncelleme paketi: image/out/whisperagent-<sürüm>.tgz (+ .sha256)
# Panelde Miner kataloğu → Agent sürümleri → "Sürüm yayınla" ile adresi ve SHA256 girilir;
# rig'ler 6 saat içinde kendini günceller.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
VERSION="$(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$REPO/agent/whisperagent/__init__.py")"
OUT="$HERE/out/whisperagent-$VERSION.tgz"
mkdir -p "$HERE/out"
tar --exclude='__pycache__' -czf "$OUT" -C "$REPO/agent" whisperagent
( cd "$HERE/out" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" && cat "$(basename "$OUT").sha256" )
