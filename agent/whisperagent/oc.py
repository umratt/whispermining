"""Overclock uygulama.

NVIDIA: önce NVML (libnvidia-ml, ekran sunucusu gerektirmez); desteklenmeyen ayarlar için nvidia-settings
        (imajdaki başsız Xorg :0 üzerinden). Bellek offset'i HiveOS / nvidia-settings birimindedir
        (Windows Afterburner değerinin iki katı); NVML'ye yarısı verilir.
AMD:    amdgpu sysfs (pp_od_clk_voltage, hwmon pwm). Çekirdek parametresi amdgpu.ppfeaturemask=0xffffffff gerekir.
params None → stok ayarlara dön.
"""
import ctypes
import os

from .util import log, read_file, run, write_file


# ---------------- NVIDIA / NVML ----------------
class _Nvml:
    def __init__(self):
        self.lib = None
        for name in ("libnvidia-ml.so.1", "libnvidia-ml.so"):
            try:
                self.lib = ctypes.CDLL(name)
                break
            except OSError:
                continue
        if self.lib and self.lib.nvmlInit_v2() != 0:
            self.lib = None

    def ok(self):
        return self.lib is not None

    def handle(self, bus_id):
        h = ctypes.c_void_p()
        busid = f"00000000:{bus_id}".upper().encode()
        rc = self.lib.nvmlDeviceGetHandleByPciBusId_v2(ctypes.c_char_p(busid), ctypes.byref(h))
        if rc != 0:
            raise RuntimeError(f"NVML kart bulunamadı ({bus_id}, kod {rc})")
        return h

    def call(self, fn, *args):
        f = getattr(self.lib, fn, None)
        if f is None:
            return None  # bu sürücüde yok
        return f(*args)


_nvml = None


def nvml():
    global _nvml
    if _nvml is None:
        _nvml = _Nvml()
    return _nvml


def _nvidia_settings(index, assignments):
    env = dict(os.environ, DISPLAY=os.environ.get("WM_XDISPLAY", ":0"))
    args = ["nvidia-settings", "-c", env["DISPLAY"]]
    for a in assignments:
        args += ["-a", f"[gpu:{index}]/{a}"]
    return run(args, timeout=20, env=env)


def apply_nvidia(gpu, params):
    """gpu: {'bus_id', 'nvidia_index'} — sonuç metni döner."""
    n = nvml()
    notes = []
    stock = not params
    p = params or {}
    if not n.ok():
        return "NVML yüklenemedi (sürücü yok mu?)"
    h = n.handle(gpu["bus_id"])

    # Güç limiti (mW)
    if stock or "power_limit_w" in p:
        if stock:
            default = ctypes.c_uint()
            n.call("nvmlDeviceGetPowerManagementDefaultLimit", h, ctypes.byref(default))
            mw = default.value
        else:
            mw = int(p["power_limit_w"]) * 1000
        rc = n.call("nvmlDeviceSetPowerManagementLimit", h, ctypes.c_uint(mw))
        notes.append(f"PL {mw // 1000}W" if rc == 0 else f"PL hata {rc}")

    # Saat offset'leri
    core = 0 if stock else p.get("core_offset")
    mem = 0 if stock else p.get("mem_offset")
    fallback = []
    if core is not None:
        rc = n.call("nvmlDeviceSetGpcClkVfOffset", h, ctypes.c_int(int(core)))
        if rc == 0:
            notes.append(f"core {core:+d}")
        else:
            fallback.append(f"GPUGraphicsClockOffsetAllPerformanceLevels={int(core)}")
    if mem is not None:
        rc = n.call("nvmlDeviceSetMemClkVfOffset", h, ctypes.c_int(int(mem) // 2))
        if rc == 0:
            notes.append(f"mem {mem:+d}")
        else:
            fallback.append(f"GPUMemoryTransferRateOffsetAllPerformanceLevels={int(mem)}")
    if fallback:
        code, out = _nvidia_settings(gpu["nvidia_index"], fallback)
        notes.append("offset (nvidia-settings)" if code == 0 else f"offset hata: {out.strip()[:120]}")

    # Fan
    fans = ctypes.c_uint()
    if n.call("nvmlDeviceGetNumFans", h, ctypes.byref(fans)) == 0:
        for f in range(fans.value):
            if stock or "fan_pct" not in p:
                n.call("nvmlDeviceSetDefaultFanSpeed_v2", h, ctypes.c_uint(f))
            else:
                n.call("nvmlDeviceSetFanSpeed_v2", h, ctypes.c_uint(f), ctypes.c_uint(int(p["fan_pct"])))
        if not stock and "fan_pct" in p:
            notes.append(f"fan {p['fan_pct']}%")
    return ", ".join(notes) or "değişiklik yok"


# ---------------- AMD / sysfs ----------------
def _od_states(text, section):
    """pp_od_clk_voltage içinden bir bölümdeki durum numaraları: Polaris OD_SCLK 0..7, Navi 0..1, Navi OD_MCLK sadece 1."""
    states, inside = [], False
    for line in text.splitlines():
        s = line.strip()
        if s.endswith(":") and s.startswith("OD_"):
            inside = s == section
            continue
        if inside and s[:1].isdigit():
            states.append(int(s.split(":", 1)[0]))
    return states


def apply_amd(gpu, params):
    dev = gpu.get("sysfs")
    if not dev:
        return "sysfs yolu yok"
    od = os.path.join(dev, "pp_od_clk_voltage")
    level = os.path.join(dev, "power_dpm_force_performance_level")
    hwmons = [os.path.join(dev, "hwmon", d) for d in os.listdir(os.path.join(dev, "hwmon"))] if os.path.isdir(os.path.join(dev, "hwmon")) else []
    hw = hwmons[0] if hwmons else None
    notes = []
    try:
        if not params:
            if os.path.exists(od):
                write_file(od, "r")
                write_file(od, "c")
            write_file(level, "auto")
            if hw:
                write_file(os.path.join(hw, "pwm1_enable"), "2")  # otomatik fan
            return "stok ayarlar"
        text = read_file(od, "") or ""
        if not text:
            return "OD desteklenmiyor (amdgpu.ppfeaturemask ayarlı mı?)"
        write_file(level, "manual")
        sclk_states = _od_states(text, "OD_SCLK:")
        mclk_states = _od_states(text, "OD_MCLK:")
        # Polaris'te (çok durumlu) voltaj da yazılır; Navi'de sadece saat
        if "core_clock" in params and sclk_states:
            top = max(sclk_states)
            cmd = f"s {top} {params['core_clock']}" + (f" {params['core_mv']}" if len(sclk_states) > 2 and "core_mv" in params else "")
            write_file(od, cmd)
            notes.append(f"core {params['core_clock']}MHz")
        if "mem_clock" in params and mclk_states:
            top = max(mclk_states)
            cmd = f"m {top} {params['mem_clock']}" + (f" {params['mem_mv']}" if len(mclk_states) > 2 and "mem_mv" in params else "")
            write_file(od, cmd)
            notes.append(f"mem {params['mem_clock']}MHz")
        write_file(od, "c")
        if hw and "fan_pct" in params:
            pmax = int(read_file(os.path.join(hw, "pwm1_max"), "255") or 255)
            write_file(os.path.join(hw, "pwm1_enable"), "1")
            write_file(os.path.join(hw, "pwm1"), str(round(int(params["fan_pct"]) * pmax / 100)))
            notes.append(f"fan {params['fan_pct']}%")
    except OSError as e:
        return f"hata: {e}"
    return ", ".join(notes) or "değişiklik yok"


def apply_all(gpus, overclock, fake_hw=None):
    """overclock: /config'teki liste. Kart başına sonuç metinleri döner."""
    by_bus = {g["bus_id"]: g for g in gpus}
    results = []
    for item in overclock or []:
        g = by_bus.get(item.get("bus_id"))
        if not g:
            continue
        params = item.get("params")
        try:
            if fake_hw is not None:
                fake_hw.oc[g["bus_id"]] = params or {}
                msg = "uygulandı (simülasyon)" if params else "stok (simülasyon)"
            elif g["vendor"] == "nvidia":
                msg = apply_nvidia(g, params)
            else:
                msg = apply_amd(g, params)
        except Exception as e:  # tek kartın hatası diğerlerini durdurmasın
            msg = f"hata: {e}"
        log.info("OC %s %s: %s", g["bus_id"], item.get("profile") or "stok", msg)
        results.append(f"{g['bus_id']} {item.get('profile') or 'stok'}: {msg}")
    return results
