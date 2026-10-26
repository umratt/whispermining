#!/bin/bash
# Windows'ta WSL2 (Ubuntu 22.04) içinde imaj derleme. Çalışma dizini WSL'in kendi ext4 diskindedir
# (RAM yetmiyor: NVIDIA + ROCm ile ~12 GB). Bitince silinir; Windows klasöründe sadece sonuç kalır.
#   cd /mnt/c/Users/<kullanıcı>/Desktop/crypto/mining && sudo bash image/build-wsl.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${BUILD_DIR:-/var/tmp/wmbuild}"
mkdir -p "$BUILD_DIR"
trap 'rc=$?; rm -rf --one-file-system "$BUILD_DIR/work"; exit $rc' EXIT   # hata kodu kaybolmasın
# Windows klasöründen çalışırken satır sonu / izin sorunları olmasın diye betikleri kopyala
rm -rf "$BUILD_DIR/src" && mkdir -p "$BUILD_DIR/src"
cp -r "$HERE/../agent" "$HERE/../image" "$BUILD_DIR/src/"
WORK_DIR="$BUILD_DIR/work" OUT_DIR="$HERE/out" VERSION="${VERSION:-1.0.0}" bash "$BUILD_DIR/src/image/build-image.sh"
