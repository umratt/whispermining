import logging
import subprocess

log = logging.getLogger("whisperagent")


def run(cmd, timeout=20, env=None, check=False):
    """Komutu çalıştır, (dönüş kodu, çıktı) döndür. Program yoksa (127, mesaj)."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    except FileNotFoundError:
        return 127, f"{cmd[0]} bulunamadı"
    except subprocess.TimeoutExpired:
        return 124, f"{cmd[0]} zaman aşımı"
    out = (p.stdout or "") + (p.stderr or "")
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} → {p.returncode}: {out.strip()[:300]}")
    return p.returncode, out


def read_file(path, default=None):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read().strip()
    except OSError:
        return default


def write_file(path, value):
    with open(path, "w", encoding="utf-8") as f:
        f.write(str(value))


def to_float(v):
    try:
        s = str(v).strip()
        if not s or s.startswith("[") or s.upper() in ("N/A", "NA"):
            return None
        return float(s)
    except (TypeError, ValueError):
        return None


def norm_bus(bus):
    """'00000000:01:00.0' / '0000:01:00.0' / '1:0' → '01:00.0' (panelde kartın kalıcı kimliği)."""
    s = str(bus).strip().lower()
    parts = s.split(":")
    if len(parts) == 3:          # domain:bus:dev.fn
        parts = parts[1:]
    if len(parts) == 2:
        bus_part, rest = parts
        dev, _, fn = rest.partition(".")
        return f"{int(bus_part, 16):02x}:{int(dev or '0', 16):02x}.{fn or '0'}"
    return s
