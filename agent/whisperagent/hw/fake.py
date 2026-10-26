"""Sahte donanım: gerçek kart olmadan agent'ı uçtan uca test etmek için (WM_FAKE_HW=rtx|p106|karma)."""
import random

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


class FakeHardware:
    def __init__(self, preset):
        cards = PRESETS.get(preset) or [c for c in preset.split(",") if c in MODELS]
        self.gpus = []
        for i, c in enumerate(cards or PRESETS["rtx"]):
            vendor, model, vram, driver = MODELS[c]
            self.gpus.append({"index": i, "bus_id": f"{i + 1:02x}:00.0", "vendor": vendor, "model": model,
                              "vram_mb": vram, "driver": driver, "vbios": "sim", "uuid": f"GPU-sim-{i}", "type": c})
        self.mining = set()   # miner'ın kullandığı bus_id'ler (sensör değerleri buna göre)
        self.oc = {}
        self.temps = {g["bus_id"]: 35.0 for g in self.gpus}

    def scan(self):
        return [{k: v for k, v in g.items() if k != "type"} for g in self.gpus]

    def sensors(self):
        out = {}
        for g in self.gpus:
            busy = g["bus_id"] in self.mining
            base = {"p106": 82, "rx580": 115, "rtx3080": 225}[g["type"]]
            limit = (self.oc.get(g["bus_id"]) or {}).get("power_limit_w")
            power = (min(base, limit) if limit else base) if busy else 10
            power *= random.uniform(0.97, 1.03)
            fan = (self.oc.get(g["bus_id"]) or {}).get("fan_pct") or (65 if busy else 30)
            target = 30 + power * (0.15 if g["type"] == "rtx3080" else 0.3) - fan * 0.1
            self.temps[g["bus_id"]] += (target - self.temps[g["bus_id"]]) * 0.3
            out[g["bus_id"]] = {"temp": round(self.temps[g["bus_id"]], 1), "mem_temp": None, "fan": fan,
                                "power": round(power, 1), "core_clk": 1500 if busy else 300, "mem_clk": 4000 if busy else 400}
        return out

    def system(self):
        return {"cpu_model": "Simülasyon CPU", "ram_total_mb": 3900, "ram_used_mb": 1200,
                "os_info": "WhisperMining OS (simülasyon)", "cpu_load": 0.3}
