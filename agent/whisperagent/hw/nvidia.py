"""NVIDIA kartları: nvidia-smi ile tarama ve sensörler."""
import glob
import re
import time

from ..util import log, norm_bus, read_file, run, to_float

SCAN_FIELDS = "index,pci.bus_id,name,memory.total,driver_version,vbios_version,uuid"
SENSOR_FIELDS = "pci.bus_id,temperature.gpu,fan.speed,power.draw,clocks.sm,clocks.mem"


# nvidia-smi takılırsa (sürücü kartı başlatamadı) her turda tekrar çağrılmaz: takılan her süreç çekirdekte asılı
# kalır ve birikir. Bu süre boyunca kart listesi boş döner, sebep problem() ile panele bildirilir.
STUCK_BACKOFF_SEC = 600
_state = {"skip_until": 0.0, "problem": None}

# Sürücünün başlatamadığı kart (bozuk riser, gevşek güç kablosu) her nvidia-smi çağrısında 1-2 dk yeniden denenir ve
# rig'deki bütün kartları görünmez yapar. Böyle bir kart PCI veriyolundan çıkarılır (sadece bu açılış için; yeniden
# başlatınca tekrar denenir), kalan kartlar kazmaya devam eder.
FAILED_RE = re.compile(r"NVRM: GPU ([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]): (?:RmInitAdapter|rm_init_adapter) failed", re.I)
disabled = {}  # "0000:08:00.0" → neden


def disable_failed():
    """dmesg'de başlatılamadığı yazan kartları devre dışı bırak. Yeni bir kart bırakıldıysa True."""
    code, out = run(["dmesg"], timeout=10)
    if code != 0:
        return False
    changed = False
    for bus in dict.fromkeys(m.group(1).lower() for m in FAILED_RE.finditer(out)):
        dev = f"/sys/bus/pci/devices/{bus}"
        if bus in disabled or not glob.glob(dev):
            continue
        # sysfs yazımı sürücü meşgulken bekleyebilir: ayrı süreçte, süre sınırıyla
        rc, msg = run(["sh", "-c", f"echo 1 > {dev}/remove"], timeout=20)
        if rc == 0:
            disabled[bus] = "sürücü kartı başlatamadı (RmInitAdapter failed)"
            log.error("Kart %s başlatılamadı, devre dışı bırakıldı: riser ve güç kablosunu kontrol edin", bus)
            changed = True
        else:
            log.warning("Kart %s devre dışı bırakılamadı: %s", bus, msg.strip()[:200])
    if changed:
        _state["skip_until"] = 0.0  # kalan kartlarla hemen tekrar dene
    return changed


def _query(fields):
    if time.monotonic() < _state["skip_until"]:
        return []
    code, out = run(["nvidia-smi", f"--query-gpu={fields}", "--format=csv,noheader,nounits"], timeout=15)
    if code == 124:
        _state["skip_until"] = time.monotonic() + STUCK_BACKOFF_SEC
        _state["problem"] = "nvidia-smi yanıt vermiyor: NVIDIA sürücüsü kartları başlatamadı"
        log.error("%s; %d dk sonra tekrar denenecek", _state["problem"], STUCK_BACKOFF_SEC // 60)
        return []
    if code != 0:
        _state["problem"] = "nvidia-smi hata verdi: " + (out.strip().splitlines() or ["?"])[0][:160]
        return []
    _state["problem"] = None
    rows = []
    for line in out.splitlines():
        cols = [c.strip() for c in line.split(",")]
        if len(cols) == len(fields.split(",")):
            rows.append(cols)
    return rows


def pci_count():
    """PCI veriyolunda görünen NVIDIA ekran kartı sayısı (sürücüden bağımsız)."""
    n = 0
    for dev in glob.glob("/sys/bus/pci/devices/*"):
        if read_file(f"{dev}/vendor", "") == "0x10de" and (read_file(f"{dev}/class", "") or "").startswith("0x03"):
            n += 1
    return n


def problem(found):
    """Çalışmayan NVIDIA kartı varsa kullanıcıya gösterilecek açıklama (dmesg'deki NVRM satırlarıyla)."""
    off = ""
    if disabled:
        buses = ", ".join(b[5:] for b in disabled)
        off = (f"{len(disabled)} kart başlatılamadığı için devre dışı bırakıldı ({buses}): riser'ını ve güç kablosunu "
               f"kontrol edin, gerekirse kartı değiştirin. Diğer kartlar çalışıyor.")
    pci = pci_count()
    if not pci or found >= pci:
        return off or None
    msg = _state["problem"] or "NVIDIA sürücüsü kartları görmüyor"
    msg = f"{pci} NVIDIA kart takılı, {found} tanesi çalışıyor. {msg}."
    code, out = run(["dmesg"], timeout=5)
    nvrm = [re.sub(r"^\[[^\]]*\]\s*", "", l) for l in out.splitlines() if "NVRM" in l] if code == 0 else []
    if nvrm:
        msg += " Sürücü: " + " | ".join(dict.fromkeys(nvrm[-4:]))[:400]
    if any(re.search(r"BAR\d? is 0M|invalid|resource", l) for l in nvrm):
        msg += " → BIOS'ta 'Above 4G Decoding' açılmalı."
    return f"{off} {msg}" if off else msg


def model_name(name):
    name = name.strip()
    return name if name.upper().startswith("NVIDIA") else f"NVIDIA {name}"


def scan():
    if pci_count():
        disable_failed()
    gpus = []
    for idx, bus, name, mem, driver, vbios, uuid in _query(SCAN_FIELDS):
        gpus.append({
            "nvidia_index": int(idx), "bus_id": norm_bus(bus), "vendor": "nvidia", "model": model_name(name),
            "vram_mb": int(to_float(mem) or 0) or None, "driver": driver, "vbios": vbios, "uuid": uuid,
        })
    return gpus


def sensors():
    out = {}
    for bus, temp, fan, power, sm, mem in _query(SENSOR_FIELDS):
        out[norm_bus(bus)] = {"temp": to_float(temp), "mem_temp": None, "fan": to_float(fan),
                              "power": to_float(power), "core_clk": to_float(sm), "mem_clk": to_float(mem)}
    # Bellek sıcaklığı sadece bazı kartlarda var (çoğu GeForce'ta N/A); destekleniyorsa ekle
    for cols in _query("pci.bus_id,temperature.memory"):
        if norm_bus(cols[0]) in out:
            out[norm_bus(cols[0])]["mem_temp"] = to_float(cols[1])
    return out
