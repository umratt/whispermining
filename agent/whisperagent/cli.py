"""Rig başında (Alt+F2) ya da SSH ile kullanılan komutlar. HiveOS'taki miner / sreboot gibi.

  wm                 canlı durum ekranı (Ctrl+C ile çık)
  wm yardim          komut listesi
  miner              miner'ın canlı çıktısı (Ctrl+C ile çık)
  miner start|stop|restart
  wm oc              panelde atanmış OC değerlerini tekrar uygula
  wm log             agent kaydı (canlı)
  wm bilgi           rig kimliği, panel adresi, sürümler
  wm guncelle        agent güncellemesini şimdi kontrol et
  sreboot            rig'i hemen yeniden başlat
"""
import glob
import json
import os
import subprocess
import sys
import time

from . import VERSION, config, display

HELP = """
  WhisperMining komutları
  ───────────────────────────────────────────────────────────
  wm                 canlı durum ekranı (Ctrl+C ile çık)
  miner              miner'ın canlı çıktısı (Ctrl+C ile çık)
  miner start        miner'ı başlat
  miner stop         miner'ı durdur (açılışta da başlamaz)
  miner restart      miner'ı yeniden başlat
  wm oc              OC değerlerini tekrar uygula
  wm log             agent kaydı (canlı)
  wm bilgi           rig bilgileri
  wm guncelle        agent güncellemesini şimdi kontrol et
  sreboot            rig'i yeniden başlat
  Alt+F1             canlı ekrana dön        Alt+F2  komut satırı
"""

CMD_DIR = os.path.join(config.RUN_DIR, "cmd")


def send(ctype, wait=90):
    """Komutu çalışan agent'a iletir ve sonucu bekler."""
    os.makedirs(CMD_DIR, mode=0o700, exist_ok=True)
    cid = f"{time.time_ns()}-{os.getpid()}"
    tmp = os.path.join(CMD_DIR, f".{cid}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"type": ctype}, f)
    os.replace(tmp, os.path.join(CMD_DIR, f"{cid}.json"))
    out = os.path.join(CMD_DIR, f"{cid}.out")
    print("  İşleniyor…", end="", flush=True)
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if os.path.exists(out):
            with open(out, encoding="utf-8") as f:
                res = json.load(f)
            os.remove(out)
            ok = res.get("status") == "done"
            print(f"\r  {'✓' if ok else '✗'} {res.get('output')}")
            return 0 if ok else 1
        time.sleep(0.5)
    print("\r  ✗ Agent yanıt vermedi. Durum: systemctl status wmining-agent")
    return 1


def live():
    path = os.path.join(config.RUN_DIR, "status.json")
    try:
        print("\033[2J", end="")
        while True:
            try:
                with open(path, encoding="utf-8") as f:
                    state = json.load(f)
                body = display.render(state, color=True)
                if time.time() - state.get("ts", 0) > 30:
                    body += "\n  \033[33m! Ekran 30 sn'dir güncellenmiyor: agent çalışıyor mu? (wm log)\033[0m\n"
            except (OSError, ValueError):
                body = "\n  Agent henüz durum yazmadı. Birkaç saniye bekleyin (wm log ile kayda bakın).\n"
            print("\033[H" + body.replace("\n", "\033[K\n") + "\033[J  Ctrl+C: çık", end="", flush=True)
            time.sleep(2)
    except KeyboardInterrupt:
        print()
        return 0


def follow(paths, title):
    paths = [p for p in paths if os.path.exists(p)]
    if not paths:
        print(f"  {title} kaydı yok (henüz başlamamış olabilir).")
        return 1
    print(f"  {title} — Ctrl+C ile çıkın\n")
    try:
        return subprocess.call(["tail", "-n", "40", "-F", *paths])
    except KeyboardInterrupt:
        return 0


def info():
    conf = config.read_conf()
    state = {}
    try:
        with open(os.path.join(config.RUN_DIR, "status.json"), encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        pass
    print(f"""
  Rig adı     : {state.get('rig_name') or conf.get('RIG_NAME') or '-'}
  Rig ID      : {conf.get('RIG_ID') or '-'}
  Panel       : {conf.get('SERVER_URL') or config.DEFAULT_SERVER_URL}
  Bağlantı    : {state.get('connection') or '-'}
  Agent       : {VERSION}
  rig.conf    : {config.conf_path()}
""")
    return 0


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    cmd = args[0].lower() if args else "durum"
    sub = args[1].lower() if len(args) > 1 else ""
    if cmd in ("durum", "status", "ekran"):
        return live()
    if cmd in ("yardim", "yardım", "help", "-h", "--help"):
        print(HELP)
        return 0
    if cmd == "miner":
        if sub in ("start", "baslat", "başlat"):
            return send("miner_start")
        if sub in ("stop", "durdur"):
            return send("miner_stop")
        if sub in ("restart", "yeniden"):
            return send("miner_restart")
        if sub in ("", "log", "ekran"):
            return follow(sorted(glob.glob(os.path.join(config.RUN_DIR, "miner-*.log"))), "Miner çıktısı")
        print(f"  Bilinmeyen: miner {sub}  (start, stop, restart)")
        return 2
    if cmd == "oc":
        return send("apply_oc")
    if cmd in ("reboot", "sreboot"):
        print("  Rig yeniden başlatılıyor…")
        if send("reboot", wait=15) != 0:  # agent takıldıysa da yeniden başlatılabilsin
            return subprocess.call(["systemctl", "reboot"])
        return 0
    if cmd in ("guncelle", "güncelle", "update"):
        return send("update", wait=15)
    if cmd == "log":
        return follow([os.path.join(config.RUN_DIR, "agent.log")], "Agent kaydı")
    if cmd in ("bilgi", "info"):
        return info()
    print(f"  Bilinmeyen komut: {cmd}")
    print(HELP)
    return 2


if __name__ == "__main__":
    sys.exit(main())
