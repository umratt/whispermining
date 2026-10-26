"""NVIDIA kartları: nvidia-smi ile tarama ve sensörler."""
from ..util import norm_bus, run, to_float

SCAN_FIELDS = "index,pci.bus_id,name,memory.total,driver_version,vbios_version,uuid"
SENSOR_FIELDS = "pci.bus_id,temperature.gpu,fan.speed,power.draw,clocks.sm,clocks.mem"


def _query(fields):
    code, out = run(["nvidia-smi", f"--query-gpu={fields}", "--format=csv,noheader,nounits"], timeout=15)
    if code != 0:
        return []
    rows = []
    for line in out.splitlines():
        cols = [c.strip() for c in line.split(",")]
        if len(cols) == len(fields.split(",")):
            rows.append(cols)
    return rows


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
