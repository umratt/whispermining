#!/bin/bash
# WhisperMining OS imajı derleme betiği.
# Ubuntu 22.04 (ya da GitHub Actions ubuntu-22.04) üzerinde root olarak çalıştırılır:
#   sudo VERSION=1.0.0 bash image/build-image.sh
# Çıktı: image/out/whispermining-<sürüm>.img.xz ve .sha256
#
# Disk düzeni (MBR, Windows'ta da görünsün diye):
#   1) FAT32 "WMINING" 512 MB  → rig.conf buraya kopyalanır, UEFI önyükleyici de burada
#   2) ext4  "wmroot"          → Ubuntu 22.04 + sürücüler + agent (ilk açılışta flash'ın tamamına büyür)
set -euo pipefail

VERSION="${VERSION:-1.0.0}"
IMG_SIZE="${IMG_SIZE:-7G}"
SUITE=jammy
MIRROR="${MIRROR:-http://archive.ubuntu.com/ubuntu}"
NVIDIA_BRANCH="${NVIDIA_BRANCH:-535}"     # GTX 10xx (P106 dahil) → RTX 40xx
# RX 470/480/570/580 (Polaris) için eski OpenCL: yeni ROCm Polaris'i desteklemiyor
AMDGPU_INSTALL_URL="${AMDGPU_INSTALL_URL:-https://repo.radeon.com/amdgpu-install/22.20.5/ubuntu/jammy/amdgpu-install_22.20.50205-1_all.deb}"
WITH_AMD_OPENCL="${WITH_AMD_OPENCL:-1}"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT_DIR="${OUT_DIR:-$HERE/out}"
# WORK_DIR: imajın derlendiği yer. RAM'de (tmpfs) derlemek için build-wsl.sh bunu ayarlar.
WORK_DIR="${WORK_DIR:-$OUT_DIR}"
IMG="$WORK_DIR/whispermining-$VERSION.img"
FINAL="$OUT_DIR/whispermining-$VERSION.img.xz"
MNT="$(mktemp -d /tmp/wmroot.XXXX)"
LOOP=""

log() { echo -e "\n==> $*"; }
cleanup() {
  set +e
  for d in wmining dev/pts dev proc sys run; do mountpoint -q "$MNT/$d" && umount -l "$MNT/$d"; done
  mountpoint -q "$MNT" && umount -l "$MNT"
  [ -n "$LOOP" ] && losetup -d "$LOOP"
  rmdir "$MNT" 2>/dev/null
}
trap cleanup EXIT

[ "$(id -u)" -eq 0 ] || { echo "root olarak çalıştırın (sudo)"; exit 1; }
grep -q 'VERSION_ID="22.04"' /etc/os-release || echo "UYARI: Ubuntu 22.04 dışında denenmedi"

log "Derleme araçları"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq debootstrap dosfstools e2fsprogs fdisk xz-utils rsync >/dev/null

log "Boş imaj ($IMG_SIZE) ve bölümler"
mkdir -p "$OUT_DIR" "$WORK_DIR"
rm -f "$IMG" "$FINAL"
truncate -s "$IMG_SIZE" "$IMG"
sfdisk --quiet "$IMG" <<EOF
label: dos
start=2048, size=512MiB, type=c, bootable
type=83
EOF
LOOP="$(losetup -fP --show "$IMG")"
mkfs.vfat -F 32 -n WMINING "${LOOP}p1" >/dev/null
mkfs.ext4 -q -L wmroot -m 1 "${LOOP}p2"

mount "${LOOP}p2" "$MNT"
mkdir -p "$MNT/wmining"
mount "${LOOP}p1" "$MNT/wmining"

log "Ubuntu $SUITE temel sistem (debootstrap)"
debootstrap --arch=amd64 --include=systemd-sysv,ca-certificates,gnupg "$SUITE" "$MNT" "$MIRROR" >/dev/null

cat > "$MNT/etc/apt/sources.list" <<EOF
deb $MIRROR $SUITE main restricted universe multiverse
deb $MIRROR $SUITE-updates main restricted universe multiverse
deb http://security.ubuntu.com/ubuntu $SUITE-security main restricted universe multiverse
EOF

for d in dev dev/pts proc sys run; do mount --bind "/$d" "$MNT/$d"; done
in_chroot() { chroot "$MNT" /usr/bin/env DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 "$@"; }

log "Çekirdek, önyükleyici ve araçlar"
in_chroot apt-get update -qq
in_chroot apt-get install -y -qq --no-install-recommends \
  linux-generic grub-pc-bin grub-efi-amd64-bin grub2-common initramfs-tools \
  python3 pciutils curl ca-certificates cloud-guest-utils gdisk dosfstools e2fsprogs \
  netplan.io iproute2 iputils-ping openssh-server sudo kbd console-setup locales tzdata less nano >/dev/null

log "NVIDIA $NVIDIA_BRANCH sürücüsü (Ubuntu'nun hazır derlenmiş modülleriyle; DKMS yok)"
in_chroot apt-get install -y -qq --no-install-recommends \
  "linux-modules-nvidia-$NVIDIA_BRANCH-generic" "nvidia-utils-$NVIDIA_BRANCH" "nvidia-compute-utils-$NVIDIA_BRANCH" \
  "libnvidia-compute-$NVIDIA_BRANCH" "xserver-xorg-video-nvidia-$NVIDIA_BRANCH" nvidia-settings xserver-xorg-core >/dev/null

if [ "$WITH_AMD_OPENCL" = "1" ]; then
  log "AMD OpenCL (Polaris için legacy)"
  curl -fsSL -o "$MNT/tmp/amdgpu-install.deb" "$AMDGPU_INSTALL_URL"
  in_chroot apt-get install -y -qq /tmp/amdgpu-install.deb >/dev/null
  in_chroot amdgpu-install -y --usecase=opencl --opencl=legacy --no-dkms --accept-eula >/dev/null
  rm -f "$MNT/tmp/amdgpu-install.deb"
fi

log "Sistem ayarları"
echo "wmining" > "$MNT/etc/hostname"
printf '127.0.0.1 localhost\n127.0.1.1 wmining\n' > "$MNT/etc/hosts"
cat > "$MNT/etc/fstab" <<'EOF'
LABEL=wmroot   /          ext4   noatime,commit=600,errors=remount-ro  0 1
LABEL=WMINING  /wmining   vfat   noatime,umask=0077,nofail,x-systemd.device-timeout=10s  0 2
tmpfs          /var/log   tmpfs  size=64m,mode=0755  0 0
tmpfs          /tmp       tmpfs  size=256m,mode=1777  0 0
EOF
# Kablolu ağ: tüm ethernet kartlarında DHCP, kablo takılı değilse açılışı bekletme
cat > "$MNT/etc/netplan/01-wmining.yaml" <<'EOF'
network:
  version: 2
  renderer: networkd
  ethernets:
    all-eth:
      match: { name: "e*" }
      dhcp4: true
      optional: true
EOF
chmod 600 "$MNT/etc/netplan/01-wmining.yaml"
# Flash ömrü: loglar sadece RAM'de
mkdir -p "$MNT/etc/systemd/journald.conf.d"
printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=32M\n' > "$MNT/etc/systemd/journald.conf.d/wmining.conf"
# Ekransız rig'de açılışta beklemesin; amdgpu OC için ppfeaturemask; riser'larda güç tasarrufu kapalı
cat > "$MNT/etc/default/grub" <<'EOF'
GRUB_DEFAULT=0
GRUB_TIMEOUT=2
GRUB_TIMEOUT_STYLE=menu
GRUB_RECORDFAIL_TIMEOUT=2
GRUB_DISTRIBUTOR="WhisperMining"
GRUB_CMDLINE_LINUX_DEFAULT="quiet consoleblank=0 amdgpu.ppfeaturemask=0xffffffff pcie_aspm=off"
GRUB_CMDLINE_LINUX=""
GRUB_TERMINAL=console
EOF
echo 'LANG=C.UTF-8' > "$MNT/etc/default/locale"
ln -sf /usr/share/zoneinfo/Europe/Istanbul "$MNT/etc/localtime"
sed -i 's/^CODESET=.*/CODESET="Lat15"/' "$MNT/etc/default/console-setup" 2>/dev/null || true
# SSH varsayılan kapalı; WMINING bölümüne authorized_keys konursa firstboot açar (sadece anahtarla giriş)
mkdir -p "$MNT/etc/ssh/sshd_config.d"
printf 'PasswordAuthentication no\nPermitRootLogin prohibit-password\n' > "$MNT/etc/ssh/sshd_config.d/wmining.conf"
in_chroot systemctl disable ssh.service >/dev/null 2>&1 || true
in_chroot passwd -l root >/dev/null

log "WhisperMining dosyaları ve agent"
# Sahiplik root, izinler sabit: depodaki (CI kullanıcısının) sahiplik/izinler imaja taşınmasın
rsync -rl --chown=root:root --chmod=D755,F644 "$HERE/rootfs/" "$MNT/"
chmod 755 "$MNT/usr/local/sbin/"wmining-*
AGENT_VERSION="$(python3 -c "import re;print(re.search(r'VERSION = \"(.+?)\"', open('$REPO/agent/whisperagent/__init__.py').read()).group(1))")"
mkdir -p "$MNT/opt/wmining/agent/releases/$AGENT_VERSION" "$MNT/var/lib/wmining"
rsync -rl --chown=root:root --chmod=D755,F644 --exclude '__pycache__' "$REPO/agent/whisperagent" "$MNT/opt/wmining/agent/releases/$AGENT_VERSION/"
install -m 755 "$REPO/agent/start.sh" "$MNT/opt/wmining/agent/start.sh"
ln -sfn "/opt/wmining/agent/releases/$AGENT_VERSION" "$MNT/opt/wmining/agent/current"
in_chroot systemctl enable wmining-firstboot.service wmining-agent.service wmining-xorg.service systemd-networkd.service >/dev/null
# tty1 agent'ın durum ekranı; giriş ekranı tty2'de
in_chroot systemctl mask getty@tty1.service >/dev/null
echo "WhisperMining OS $VERSION (agent $AGENT_VERSION, NVIDIA $NVIDIA_BRANCH)" > "$MNT/etc/wmining-release"

log "WMINING bölümü içeriği"
install -m 644 "$HERE/fat/OKUBENI.txt" "$MNT/wmining/OKUBENI.txt"
install -m 644 "$HERE/fat/rig.conf.ornek" "$MNT/wmining/rig.conf.ornek"

log "Önyükleyici (BIOS + UEFI)"
in_chroot grub-install --target=i386-pc --boot-directory=/boot "$LOOP" >/dev/null
in_chroot grub-install --target=x86_64-efi --efi-directory=/wmining --boot-directory=/boot --removable --no-nvram >/dev/null
in_chroot update-initramfs -u -k all >/dev/null
in_chroot update-grub >/dev/null 2>&1

log "Temizlik"
in_chroot apt-get clean
rm -rf "$MNT/var/lib/apt/lists/"* "$MNT/tmp/"* "$MNT/root/.bash_history"
: > "$MNT/etc/machine-id"           # her rig ilk açılışta kendi kimliğini üretir
rm -f "$MNT/var/lib/dbus/machine-id" "$MNT/etc/ssh/ssh_host_"*

cleanup
trap - EXIT
LOOP=""
set -e

log "Sıkıştırma"
xz -T0 -6 -c "$IMG" > "$FINAL"
rm -f "$IMG"
( cd "$OUT_DIR" && sha256sum "$(basename "$FINAL")" > "$(basename "$FINAL").sha256" )
ls -lh "$FINAL"
cat "$FINAL.sha256"
