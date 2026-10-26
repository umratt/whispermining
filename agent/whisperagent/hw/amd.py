"""AMD kartları: amdgpu sürücüsünün sysfs dosyalarından tarama ve sensörler."""
import glob
import os
import re

from ..util import norm_bus, read_file, run, to_float

# Madencilikte yaygın kartlar: (aygıt kimliği, revizyon) → ad. Listede yoksa lspci adı kullanılır.
KNOWN = {
    ("0x67df", "0xe7"): "AMD Radeon RX 580", ("0x67df", "0xc7"): "AMD Radeon RX 480",
    ("0x67df", "0xef"): "AMD Radeon RX 570", ("0x67df", "0xcf"): "AMD Radeon RX 470",
    ("0x67df", "0xe1"): "AMD Radeon RX 590", ("0x6fdf", "0xef"): "AMD Radeon RX 580 2048SP",
    ("0x67ef", "0xcf"): "AMD Radeon RX 460", ("0x699f", "0xc7"): "AMD Radeon RX 550",
    ("0x687f", "0xc3"): "AMD Radeon RX Vega 56", ("0x687f", "0xc1"): "AMD Radeon RX Vega 64",
    ("0x731f", "0xc1"): "AMD Radeon RX 5700 XT", ("0x731f", "0xc4"): "AMD Radeon RX 5700",
    ("0x73ff", "0xc7"): "AMD Radeon RX 6600 XT", ("0x73ff", "0xc1"): "AMD Radeon RX 6600",
    ("0x73df", "0xc1"): "AMD Radeon RX 6700 XT", ("0x73bf", "0xc1"): "AMD Radeon RX 6800 XT",
}


def _cards():
    """[(kart dizini, pci adresi)]: sadece AMD (vendor 0x1002), card0-DP-1 gibi bağlantılar hariç."""
    out = []
    for card in sorted(glob.glob("/sys/class/drm/card[0-9]*")):
        if not re.fullmatch(r"card\d+", os.path.basename(card)):
            continue
        dev = os.path.join(card, "device")
        if read_file(os.path.join(dev, "vendor")) != "0x1002":
            continue
        out.append((dev, os.path.basename(os.path.realpath(dev))))
    return out


def _hwmon(dev):
    found = glob.glob(os.path.join(dev, "hwmon", "hwmon*"))
    return found[0] if found else None


def _model(dev, pci):
    did, rev = read_file(os.path.join(dev, "device"), ""), read_file(os.path.join(dev, "revision"), "")
    if (did, rev) in KNOWN:
        name = KNOWN[(did, rev)]
    else:
        code, out = run(["lspci", "-s", pci, "-mm"], timeout=5)
        m = re.search(r'\[(Radeon[^\]]*)\]', out) if code == 0 else None
        name = f"AMD {m.group(1)}" if m else f"AMD GPU {did}"
    vram = to_float(read_file(os.path.join(dev, "mem_info_vram_total")))
    if vram and name.endswith(("RX 580", "RX 570", "RX 480", "RX 470")):
        name += f" {round(vram / 2**30)}GB"
    return name


def scan():
    # Çekirdek içi amdgpu'nun ayrı sürüm numarası yoktur; çekirdek sürümü gösterilir
    ver = read_file("/sys/module/amdgpu/version") or (os.uname().release if hasattr(os, "uname") else "")
    driver = f"amdgpu {ver}".strip()
    gpus = []
    for dev, pci in _cards():
        vram = to_float(read_file(os.path.join(dev, "mem_info_vram_total")))
        gpus.append({"bus_id": norm_bus(pci), "vendor": "amd", "model": _model(dev, pci),
                     "vram_mb": int(vram / 2**20) if vram else None, "driver": driver.strip(),
                     "vbios": read_file(os.path.join(dev, "vbios_version")), "uuid": None, "sysfs": dev})
    return gpus


def _current_clock(path):
    """pp_dpm_sclk satırı: '7: 1150Mhz *' → 1150"""
    for line in (read_file(path, "") or "").splitlines():
        if line.strip().endswith("*"):
            m = re.search(r"(\d+)\s*Mhz", line, re.I)
            if m:
                return float(m.group(1))
    return None


def sensors():
    out = {}
    for dev, pci in _cards():
        hw = _hwmon(dev)
        temp = mem_temp = fan = power = None
        if hw:
            t = to_float(read_file(os.path.join(hw, "temp1_input")))
            temp = t / 1000 if t is not None else None
            mt = to_float(read_file(os.path.join(hw, "temp3_input")))  # Vega ve sonrası: bellek
            mem_temp = mt / 1000 if mt is not None else None
            pwm = to_float(read_file(os.path.join(hw, "pwm1")))
            pmax = to_float(read_file(os.path.join(hw, "pwm1_max"))) or 255
            fan = round(pwm * 100 / pmax) if pwm is not None else None
            p = to_float(read_file(os.path.join(hw, "power1_average")) or read_file(os.path.join(hw, "power1_input")))
            power = p / 1e6 if p is not None else None
        out[norm_bus(pci)] = {"temp": temp, "mem_temp": mem_temp, "fan": fan, "power": power,
                              "core_clk": _current_clock(os.path.join(dev, "pp_dpm_sclk")),
                              "mem_clk": _current_clock(os.path.join(dev, "pp_dpm_mclk"))}
    return out
