"""Monitör bağlıysa tty1'e canlı durum ekranı yazar (HiveOS gibi, birkaç saniyede bir yenilenir).
Her durumda /run/wmining/status.txt ve status.json güncellenir; 'wm' komutu bunları gösterir.
Monitör yoksa hiçbir şey beklenmez, rig tamamen panelden yönetilir."""
import json
import os
import socket
import time

from . import VERSION
from .config import RUN_DIR

# Renkler (sadece ekranda; status.txt düz yazı kalır)
C = {"g": "\033[32m", "y": "\033[33m", "r": "\033[31m", "c": "\033[36m", "b": "\033[1m", "d": "\033[2m", "0": "\033[0m"}


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
            return f"{h:.2f} {unit}"
        h /= 1000
    return f"{h:.2f} TH/s"


def _fmt_uptime(sec):
    if not sec:
        return "-"
    h, rem = divmod(int(sec), 3600)
    return f"{h} sa {rem // 60} dk" if h else f"{rem // 60} dk {rem % 60} sn"


def _num(v):
    return v if isinstance(v, (int, float)) else 0


def render(state, color=False):
    def c(key, text):
        return f"{C[key]}{text}{C['0']}" if color else text

    gpus = state.get("gpus") or []
    total = sum(_num(g.get("hashrate")) for g in gpus)
    acc = sum(_num(g.get("accepted")) for g in gpus)
    rej = sum(_num(g.get("rejected")) for g in gpus)
    power = sum(_num(g.get("power")) for g in gpus)
    fl = state.get("flight") or {}
    miner = state.get("miner") or "-"
    mcol = {"çalışıyor": "g", "hata": "r", "durduruldu": "y"}.get(miner, "c")
    conn = state.get("connection") or "-"

    lines = [
        c("b", f"  WhisperMining {VERSION}") + f"   {state.get('rig_name') or '-'}   {time.strftime('%d.%m.%Y %H:%M:%S')}",
        "  " + "─" * 74,
        f"  IP {_ip():<16} Panel: {c('g' if conn == 'bağlı' else 'y', conn)}",
        f"  Coin {fl.get('coin') or '-'} · {fl.get('algo') or '-'}   Havuz: {fl.get('pool') or '-'}",
        f"  Miner: {c(mcol, miner)} {', '.join(fl.get('miners') or [])}   Çalışma: {_fmt_uptime(state.get('uptime'))}",
        "",
        c("b", f"  TOPLAM  {_fmt_hash(total):>14}") + f"   {power:.0f} W   Share: {c('g', f'{acc:.0f}')} kabul / {c('r' if rej else 'd', f'{rej:.0f}')} red",
    ]
    if state.get("pairing_code"):
        lines += ["", c("y", f"  >>> Panelde 'Rig ekle > Eşleştirme kodu' bölümüne girin:  {state['pairing_code']}  <<<")]
    if state.get("error"):
        lines += ["", c("r", f"  ! {state['error']}")]
    t = state.get("tune")
    if t and t.get("status") == "running":
        lines += ["", c("c", f"  Otomatik OC sürüyor: adım {t.get('step')}, kalan ~{int((t.get('eta_sec') or 0) / 60)} dk")]
    if gpus:
        lines += ["", c("d", f"  {'#':<3}{'Kart':<26}{'Hashrate':>13}{'Sıc.':>7}{'Bel.':>6}{'Fan':>6}{'Güç':>7}{'K/R':>9}")]
        for g in gpus:
            temp = g.get("temp")
            tcol = "r" if temp is not None and temp >= 80 else ("y" if temp is not None and temp >= 70 else "0")
            ts = f"{temp:.0f}°" if temp is not None else "-"
            mt = f"{g['mem_temp']:.0f}°" if g.get("mem_temp") is not None else "-"
            f = f"{g['fan']:.0f}%" if g.get("fan") is not None else "-"
            p = f"{g['power']:.0f}W" if g.get("power") is not None else "-"
            ar = f"{_num(g.get('accepted')):.0f}/{_num(g.get('rejected')):.0f}" if g.get("accepted") is not None else "-"
            hs = _fmt_hash(g.get("hashrate"))
            lines.append(f"  {g.get('index', '-'):<3}{str(g.get('model', ''))[:25]:<26}{c('g' if g.get('hashrate') else 'd', f'{hs:>13}')}"
                         f"{c(tcol, f'{ts:>7}')}{mt:>6}{f:>6}{p:>7}{ar:>9}")
    lines += ["", c("d", "  Komutlar için Alt+F2:  wm · miner · miner restart · sreboot · wm yardim")]
    return "\n".join(lines) + "\n"


def show(state):
    text = render(state)
    try:
        os.makedirs(RUN_DIR, exist_ok=True)
        with open(os.path.join(RUN_DIR, "status.txt"), "w", encoding="utf-8") as f:
            f.write(text)
        tmp = os.path.join(RUN_DIR, "status.json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({**state, "ts": time.time()}, f, ensure_ascii=False, default=str)
        os.replace(tmp, os.path.join(RUN_DIR, "status.json"))
    except OSError:
        pass
    tty = os.environ.get("WM_TTY", "/dev/tty1")
    if tty and os.path.exists(tty):
        try:
            with open(tty, "w", encoding="utf-8") as f:
                # Başa dön, satır sonlarını temizle: her yenilemede ekran yanıp sönmez
                body = render(state, color=True).replace("\n", "\033[K\n")
                f.write("\033[?25l\033[H" + body + "\033[J")
        except OSError:
            pass  # ekran yok ya da izin yok: sorun değil
