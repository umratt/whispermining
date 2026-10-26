"""Sahte donanım: gerçek kart olmadan agent'ı uçtan uca test etmek için (WM_FAKE_HW=rtx|p106|karma).

OC'ye tepki veren basit bir model içerir (otomatik OC'yi test etmek için): her kartın kendine özgü bir
"tatlı nokta"sı var; onun üstünde bellek hızlanmaz, çok üstünde kart hata verir (hashrate 0).
"""
import random
import zlib

MODELS = {
    "p106": ("nvidia", "NVIDIA P106-100", 6144, "535.183.01"),
    "rx580": ("amd", "AMD Radeon RX 580 8GB", 8192, "amdgpu 5.15.0-125-generic"),
    "rtx3080": ("nvidia", "NVIDIA GeForce RTX 3080", 10240, "535.183.01"),
}
PRESETS = {
    "karma": ["rx580", "rx580", "p106", "p106", "p106", "p106"],
    "p106": ["p106"] * 8,
    "rtx": ["rtx3080"] * 3,
}
# kart başına stok güç ve hashrate (etchash)
BASE = {"p106": (82, 21e6), "rx580": (118, 30e6), "rtx3080": (228, 96e6)}


class FakeHardware:
    def __init__(self, preset):
        cards = PRESETS.get(preset) or [c for c in preset.split(",") if c in MODELS]
        self.gpus = []
        self.curve = {}
        for i, c in enumerate(cards or PRESETS["rtx"]):
            vendor, model, vram, driver = MODELS[c]
            bus = f"{i + 1:02x}:00.0"
            self.gpus.append({"index": i, "bus_id": bus, "vendor": vendor, "model": model,
                              "vram_mb": vram, "driver": driver, "vbios": "sim", "uuid": f"GPU-sim-{i}", "type": c})
            rnd = random.Random(zlib.crc32(bus.encode()))  # her kart her çalıştırmada aynı davranır
            self.curve[bus] = {"mem_sweet": {"p106": rnd.randint(6, 9) * 100, "rtx3080": rnd.randint(9, 13) * 100}.get(c, 0),
                               "mclk_sweet": 2000 + rnd.randint(5, 8) * 25, "mv_min": 850 + rnd.randint(0, 2) * 25}
        self.mining = set()   # miner'ın kullandığı bus_id'ler
        self.oc = {}
        self.temps = {g["bus_id"]: 35.0 for g in self.gpus}

    def scan(self):
        return [{k: v for k, v in g.items() if k != "type"} for g in self.gpus]

    def _model(self, g):
        """(hashrate çarpanı, güç W) — OC'ye göre. Çarpan 0 = kart hata veriyor."""
        p = self.oc.get(g["bus_id"]) or {}
        c = self.curve[g["bus_id"]]
        base_w, _ = BASE[g["type"]]
        if g["vendor"] == "nvidia":
            mem = p.get("mem_offset", 0)
            if mem > c["mem_sweet"] + 150:
                return 0.0, base_w * 0.6
            gain = 1 + 0.12 * min(max(mem, 0), c["mem_sweet"]) / max(c["mem_sweet"], 1)
            core = p.get("core_offset", 0)
            need = base_w * (1 + 0.03 * mem / 1000) * (1 - 0.04 * min(3, max(0, -core) / 100))
            if core < -300:
                gain *= 0.95  # çekirdek fazla düşük: etchash'te de yavaşlar
            pl = p.get("power_limit_w")
            power = min(need, pl) if pl else need
            if pl and pl < need * 0.92:
                gain *= pl / (need * 0.92)  # güç yetmiyor: hashrate düşer
            return gain, power
        mclk = p.get("mem_clock", 2000)
        mv = p.get("core_mv", 1000)
        if mclk > c["mclk_sweet"] + 25 or mv < c["mv_min"]:
            return 0.0, base_w * 0.6
        gain = 1 + 0.08 * (min(mclk, c["mclk_sweet"]) - 2000) / max(c["mclk_sweet"] - 2000, 1)
        return gain, base_w * (mv / 1000) ** 2

    def fake_hash(self, bus, h):
        g = next(x for x in self.gpus if x["bus_id"] == bus)
        _, base_h = BASE[g["type"]]
        gain, _ = self._model(g)
        return base_h * gain * random.uniform(0.995, 1.005) if bus in self.mining and h else 0

    def sensors(self):
        out = {}
        for g in self.gpus:
            busy = g["bus_id"] in self.mining
            _, power = self._model(g) if busy else (0, 10)
            power *= random.uniform(0.99, 1.01)
            fan = (self.oc.get(g["bus_id"]) or {}).get("fan_pct") or (65 if busy else 30)
            target = 30 + power * (0.15 if g["type"] == "rtx3080" else 0.3) - fan * 0.1
            self.temps[g["bus_id"]] += (target - self.temps[g["bus_id"]]) * 0.3
            out[g["bus_id"]] = {"temp": round(self.temps[g["bus_id"]], 1), "mem_temp": None, "fan": fan,
                                "power": round(power, 1), "core_clk": 1500 if busy else 300, "mem_clk": 4000 if busy else 400}
        return out

    def system(self):
        return {"cpu_model": "Simülasyon CPU", "ram_total_mb": 3900, "ram_used_mb": 1200,
                "os_info": "WhisperMining OS (simülasyon)", "cpu_load": 0.3}
