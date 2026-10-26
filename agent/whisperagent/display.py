"""Monitör bağlıysa tty1'e durum ekranı yazar; her durumda /run/wmining/status.txt güncellenir.
Monitör yoksa hiçbir şey beklenmez, rig tamamen panelden yönetilir."""
import os
import socket
import time

from . import VERSION
from .config import RUN_DIR


def _ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("1.1.1.1", 80))  # paket gönderilmez, sadece çıkış arayüzü seçilir
            return s.getsockname()[0]
    except OSError:
        return "bağlantı yok"


def _fmt_hash(h):
    if not h:
        return "-"
    for unit in ("H/s", "kH/s", "MH/s", "GH/s"):
        if h < 1000:
            return f"{h:.1f} {unit}"
        h /= 1000
    return f"{h:.1f} TH/s"


def render(state):
    lines = [
        f"  WhisperMining agent {VERSION}    {time.strftime('%d.%m.%Y %H:%M:%S')}",
        "  " + "-" * 68,
        f"  Rig      : {state.get('rig_name') or '-'}",
        f"  IP       : {_ip()}",
        f"  Panel    : {state.get('server') or '-'}",
        f"  Bağlantı : {state.get('connection') or '-'}",
        f"  Miner    : {state.get('miner') or '-'}",
    ]
    if state.get("pairing_code"):
        lines += ["", f"  >>> Panelde 'Rig ekle > Eşleştirme kodu' bölümüne girin:  {state['pairing_code']}  <<<"]
    if state.get("error"):
        lines += ["", f"  ! {state['error']}"]
    gpus = state.get("gpus") or []
    if gpus:
        lines += ["", f"  {'#':<3}{'Kart':<30}{'Hashrate':>12}{'Sıc.':>7}{'Fan':>6}{'Güç':>7}"]
        for g in gpus:
            t = f"{g['temp']:.0f}°C" if g.get("temp") is not None else "-"
            f = f"{g['fan']:.0f}%" if g.get("fan") is not None else "-"
            p = f"{g['power']:.0f}W" if g.get("power") is not None else "-"
            lines.append(f"  {g['index']:<3}{g['model'][:29]:<30}{_fmt_hash(g.get('hashrate')):>12}{t:>7}{f:>6}{p:>7}")
    return "\n".join(lines) + "\n"


def show(state):
    text = render(state)
    try:
        os.makedirs(RUN_DIR, exist_ok=True)
        with open(os.path.join(RUN_DIR, "status.txt"), "w", encoding="utf-8") as f:
            f.write(text)
    except OSError:
        pass
    tty = os.environ.get("WM_TTY", "/dev/tty1")
    if tty and os.path.exists(tty):
        try:
            with open(tty, "w", encoding="utf-8") as f:
                f.write("\033[2J\033[H" + text)  # ekranı temizle, başa dön
        except OSError:
            pass  # ekran yok ya da izin yok: sorun değil
