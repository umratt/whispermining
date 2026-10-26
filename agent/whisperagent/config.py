"""rig.conf okuma/yazma ve agent ayarları."""
import glob
import hashlib
import os

# Flash belleğin FAT bölümü (etiket WMINING) imajda buraya bağlanır
DEFAULT_CONF_PATHS = ["/wmining/rig.conf"]
DEFAULT_SERVER_URL = "https://www.whisperkripto.com/mining"

STATE_DIR = os.environ.get("WM_STATE_DIR", "/var/lib/wmining")  # flash üzerinde, kalıcı
RUN_DIR = os.environ.get("WM_RUN_DIR", "/run/wmining")          # RAM'de: loglar, durum dosyası


def conf_path():
    env = os.environ.get("WM_CONF")
    if env:
        return env
    for p in DEFAULT_CONF_PATHS:
        if os.path.exists(p):
            return p
    return DEFAULT_CONF_PATHS[0]


def parse_conf(text):
    """KEY=VALUE satırları. Windows'ta düzenlenmiş olabilir: BOM, CRLF, tırnak."""
    out = {}
    text = text.lstrip("﻿")
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().upper()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key:
            out[key] = value
    return out


def read_conf(path=None):
    path = path or conf_path()
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return parse_conf(f.read())
    except FileNotFoundError:
        return {}


def write_conf(values, path=None):
    """Atomik yazım: yarım kalmış dosya flash'ta bozuk kimlik bırakmasın."""
    path = path or conf_path()
    lines = ["# WhisperMining rig ayar dosyası (agent tarafından yazıldı)"]
    for key in ("RIG_ID", "RIG_SECRET", "RIG_NAME", "SERVER_URL", "SOURCE"):
        if values.get(key):
            lines.append(f"{key}={values[key]}")
    for key, value in values.items():
        if key not in ("RIG_ID", "RIG_SECRET", "RIG_NAME", "SERVER_URL", "SOURCE"):
            lines.append(f"{key}={value}")
    data = "\r\n".join(lines) + "\r\n"  # Windows'ta da düzgün görünsün
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _read(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read().strip()
    except OSError:
        return ""


def hw_fingerprint():
    """Donanıma bağlı sabit kimlik. machine-id kullanılmaz: aynı imaj her rig'de aynıdır."""
    override = os.environ.get("WM_FINGERPRINT")
    if override:
        return override
    parts = [_read("/sys/class/dmi/id/product_uuid"), _read("/sys/class/dmi/id/board_serial"),
             _read("/sys/class/dmi/id/board_name")]
    macs = []
    for dev in sorted(glob.glob("/sys/class/net/*")):
        name = os.path.basename(dev)
        # sadece fiziksel ağ kartları (sanal arayüzlerin "device" bağlantısı yoktur)
        if name == "lo" or not os.path.exists(os.path.join(dev, "device")):
            continue
        mac = _read(os.path.join(dev, "address"))
        if mac and mac != "00:00:00:00:00:00":
            macs.append(mac)
    parts.extend(macs)
    seed = "|".join(p for p in parts if p)
    if not seed:
        seed = _read("/etc/machine-id") or "unknown"
    return hashlib.sha256(seed.encode()).hexdigest()[:32]
