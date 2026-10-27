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
    """Takılı olan NVIDIA kartı varsa, kullanıcıya gösterilecek açıklama (dmesg'deki NVRM satırlarıyla)."""
    pci = pci_count()
    if not pci or found >= pci:
        return None
    msg = _state["problem"] or "NVIDIA sürücüsü kartları görmüyor"
    msg = f"{pci} NVIDIA kart takılı, {found} tanesi çalışıyor. {msg}."
    code, out = run(["dmesg"], timeout=5)
    nvrm = [re.sub(r"^\[[^\]]*\]\s*", "", l) for l in out.splitlines() if "NVRM" in l] if code == 0 else []
    if nvrm:
        msg += " Sürücü: " + " | ".join(dict.fromkeys(nvrm[-4:]))[:400]
    if any(re.search(r"BAR\d? is 0M|invalid|resource", l) for l in nvrm):
        msg += " → BIOS'ta 'Above 4G Decoding' açılmalı."
    return msg


def model_name(name):
    name = name.strip()
    return name if name.upper().startswith("NVIDIA") else f"NVIDIA {name}"


def scan():
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
