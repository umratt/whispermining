#!/bin/bash
# Windows'ta WSL2 (Ubuntu 22.04) içinde imaj derleme. İmaj RAM'de (tmpfs) oluşturulur, böylece
# Windows diskinde sadece sonuç dosyası (~1,5 GB) yer kaplar.
#   cd /mnt/c/Users/<kullanıcı>/Desktop/crypto/mining && sudo bash image/build-wsl.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RAM_DIR=/mnt/wmbuild
mkdir -p "$RAM_DIR"
mountpoint -q "$RAM_DIR" || mount -t tmpfs -o size=12G tmpfs "$RAM_DIR"
trap 'umount -l "$RAM_DIR" 2>/dev/null || true' EXIT
# Windows klasöründen çalışırken satır sonu / izin sorunları olmasın diye betikleri RAM'e kopyala
rm -rf "$RAM_DIR/src" && mkdir -p "$RAM_DIR/src"
cp -r "$HERE/../agent" "$HERE/../image" "$RAM_DIR/src/"
WORK_DIR="$RAM_DIR/work" OUT_DIR="$HERE/out" VERSION="${VERSION:-1.0.0}" bash "$RAM_DIR/src/image/build-image.sh"
