"""Rig'in kendi ekranı için kurulum: wm / miner / sreboot komutları ve tty2'de hazır konsol.

Agent her açılışta çalıştırır (dosyalar zaten doğruysa dokunmaz). Böylece eski imajla yazılmış
flash'lar da agent güncellemesiyle bu özellikleri alır.
  tty1 (Alt+F1): canlı durum ekranı      tty2 (Alt+F2): komut satırı, şifresiz root (sadece rig başındaki klavye)
SSH bu ayardan etkilenmez: yine sadece anahtarla ve sadece authorized_keys varsa açılır.
"""
import os
import subprocess

from .util import log

AGENT_HOME = "/opt/wmining/agent/current"

WRAPPERS = {
    "/usr/local/bin/wm": '#!/bin/sh\nPYTHONPATH="{home}" exec python3 -m whisperagent.cli "$@"\n',
    "/usr/local/bin/miner": '#!/bin/sh\nexec /usr/local/bin/wm miner "$@"\n',
    "/usr/local/bin/sreboot": '#!/bin/sh\nexec /usr/local/bin/wm reboot "$@"\n',
}

AUTOLOGIN = "[Service]\nExecStart=\nExecStart=-/sbin/agetty --autologin root --noclear %I $TERM\n"
GETTY_DROPINS = ["/etc/systemd/system/getty@tty2.service.d/wmining.conf",
                 "/etc/systemd/system/autovt@tty2.service.d/wmining.conf"]

PROFILE = """# WhisperMining: konsola girişte kısa yardım
case "$-" in *i*)
  if [ -z "$WM_HELLO" ]; then
    export WM_HELLO=1
    echo
    echo "  WhisperMining komutları:  wm (canlı ekran)  miner (miner çıktısı)  miner restart  sreboot  wm yardim"
    echo
  fi ;;
esac
"""


def _write(path, text, mode):
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == text:
                return False
    except OSError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)
    return True


def provision():
    if os.geteuid() != 0 or not os.path.isdir("/etc/systemd/system"):
        return
    try:
        home = AGENT_HOME if os.path.isdir(AGENT_HOME) else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        for path, text in WRAPPERS.items():
            _write(path, text.format(home=home), 0o755)
        _write("/etc/profile.d/wmining.sh", PROFILE, 0o644)
        changed = [p for p in GETTY_DROPINS if _write(p, AUTOLOGIN, 0o644)]
        if changed:
            subprocess.run(["systemctl", "daemon-reload"], capture_output=True, check=False, timeout=30)
            # tty2'de kimse yoksa giriş ekranını yeni ayarla başlat (açık oturum varsa dokunma)
            who = subprocess.run(["who"], capture_output=True, text=True, check=False, timeout=10).stdout
            if " tty2 " not in f" {who} ":
                subprocess.run(["systemctl", "restart", "getty@tty2.service"], capture_output=True, check=False, timeout=30)
            log.info("Konsol hazırlandı: Alt+F2 ile komut satırı (wm yardim)")
    except Exception as e:  # konsol kurulamasa da madencilik sürsün
        log.warning("Konsol kurulamadı: %s", e)
