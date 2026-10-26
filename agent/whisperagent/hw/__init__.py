"""Kart tarama ve sensör okuma. Her arka uç aynı biçimde liste döndürür.

scan()  → [{index, bus_id, vendor, model, vram_mb, driver, vbios, uuid}]
sensors() → {bus_id: {temp, mem_temp, fan, power, core_clk, mem_clk}}
"""
import os

from . import amd, nvidia


def backend():
    fake = os.environ.get("WM_FAKE_HW")
    if fake:
        from . import fake as fake_mod
        return fake_mod.FakeHardware(fake)
    return RealHardware()


class RealHardware:
    def scan(self):
        gpus = nvidia.scan() + amd.scan()
        gpus.sort(key=lambda g: g["bus_id"])
        for i, g in enumerate(gpus):
            g["index"] = i  # panel sırası: PCI adresine göre
        return gpus

    def sensors(self):
        out = nvidia.sensors()
        out.update(amd.sensors())
        return out

    def system(self):
        return system_info()


def system_info():
    from ..util import read_file
    cpu = ""
    try:
        with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.startswith("model name"):
                    cpu = line.split(":", 1)[1].strip()
                    break
    except OSError:
        pass
    mem_total = mem_avail = None
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    mem_total = int(line.split()[1]) // 1024
                elif line.startswith("MemAvailable:"):
                    mem_avail = int(line.split()[1]) // 1024
    except OSError:
        pass
    os_info = ""
    rel = read_file("/etc/os-release", "") or ""
    for line in rel.splitlines():
        if line.startswith("PRETTY_NAME="):
            os_info = line.split("=", 1)[1].strip('"')
    try:
        load = os.getloadavg()[0]
    except (OSError, AttributeError):
        load = None
    return {"cpu_model": cpu, "ram_total_mb": mem_total,
            "ram_used_mb": (mem_total - mem_avail) if mem_total and mem_avail else None,
            "os_info": os_info, "cpu_load": load}
