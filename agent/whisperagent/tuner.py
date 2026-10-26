"""Otomatik OC: bir kart modelindeki tüm kartlara aynı değerleri adım adım dener, en verimli KARARLI değeri bulur.

Her adım: değerleri uygula → kartların oturmasını bekle → ölç (hashrate, güç, sıcaklık, red/çökme) → karar ver.
Kararsızlık (çökme, hashrate 0, red share artışı, sıcaklık sınırı) görülürse son sağlam değere döner ve o aşamayı bitirir.
Sonuç bir öneridir: panel onu profil olarak kaydeder, kullanıcı uygular. Panel sınırları (bounds) asla aşılmaz.

NVIDIA: taban ölçüm → bellek offset (+100) → güç limiti (-%5) → çekirdek offset (-100)
AMD:    taban ölçüm → bellek saati (+25 MHz) → çekirdek voltajı (-25 mV)
"""
import os
import time

# Başlangıç değerleri (kullanıcının profili yoksa). Güvenli tarafta: asıl iş adım adım arama.
PRESETS = {
    ("P106-100", "etchash"): {"core_offset": 0, "mem_offset": 400},
    ("RTX 3080", "etchash"): {"core_offset": 0, "mem_offset": 600},
    ("RX 580", "etchash"): {"core_clock": 1150, "mem_clock": 2000, "core_mv": 950},
}
DEFAULT = {"nvidia": {"core_offset": 0, "mem_offset": 0}, "amd": {"core_clock": 1150, "mem_clock": 2000, "core_mv": 950}}


def preset_for(model, algo, vendor):
    for (name, a), p in PRESETS.items():
        if name.lower() in model.lower() and a == algo:
            return dict(p)
    return dict(DEFAULT[vendor])


class Tuner:
    def __init__(self, cmd_id, payload, gpus, step_sec=None, t=None):
        self.cmd_id = cmd_id
        self.model = payload["model"]
        self.vendor = payload.get("vendor") or "nvidia"
        self.algo = payload.get("algo") or ""
        self.temp_limit = float(payload.get("temp_limit") or 80)
        self.bounds = payload.get("bounds") or {}
        self.targets = [g["bus_id"] for g in gpus if g["model"] == self.model]
        self.step_sec = int(step_sec or os.environ.get("WM_TUNE_STEP_SEC") or 180)
        self.settle = max(5, int(self.step_sec * 0.35))
        start = dict(payload.get("start") or {}) or preset_for(self.model, self.algo, self.vendor)
        self.start_params = self._clamp(start)
        self.current = dict(self.start_params)
        self.good = dict(self.start_params)
        self.phases = ["baseline", "mem", "power", "core"] if self.vendor == "nvidia" else ["baseline", "mem", "voltage"]
        self.phase_i = 0
        self.no_gain = 0
        self.steps = 0
        self.max_steps = 40
        self.best = None          # en iyi kararlı ölçüm: {hash, power, eff, temp}
        self.baseline = None
        self.power_ref = None
        self.history = []         # [(aşama, değerler, ölçüm, kararlı mı)]
        self.finished = False
        self.fell_back = False    # mevcut profil kararsız çıkıp güvenli başlangıca dönüldü mü
        self.failed = None
        self.cancelled = False
        self._begin_step(t or time.time())

    # ---------- yardımcılar ----------
    def _clamp(self, p):
        out = {}
        for k, v in p.items():
            if v is None:
                continue
            lo, hi = (self.bounds.get(k) or [-10**6, 10**6])
            out[k] = int(min(hi, max(lo, round(float(v)))))
        return out

    def _begin_step(self, t):
        self.step_started = t
        self.samples = []
        self.restarts_at_start = None

    def phase(self):
        return self.phases[self.phase_i] if self.phase_i < len(self.phases) else "final"

    def wanted_params(self):
        return dict(self.current)

    # ---------- ölçüm ----------
    def feed(self, rows, miners_ok, restarts, t=None):
        """Her istatistik turunda çağrılır. Oturma süresinden sonraki örnekler ölçüme girer."""
        if self.finished:
            return
        if self.restarts_at_start is None:
            self.restarts_at_start = restarts
        if (t or time.time()) - self.step_started < self.settle:
            return
        by = {r["bus_id"]: r for r in rows}
        sample = []
        for b in self.targets:
            r = by.get(b)
            if r is None:
                self.samples.append(None)  # kart kayboldu
                return
            sample.append(r)
        self.samples.append({"rows": sample, "ok": miners_ok and restarts == self.restarts_at_start})

    def _measure(self):
        good = [s for s in self.samples if s]
        if not good or any(s is None for s in self.samples):
            return None, "kart kayboldu"
        n = len(good)
        hashes = [sum(r.get("hashrate") or 0 for r in s["rows"]) for s in good]
        powers = [sum(r.get("power") or 0 for r in s["rows"]) for s in good]
        temps = [max((r.get("temp") or 0) for r in s["rows"]) for s in good]
        rej = [sum(r.get("rejected") or 0 for r in s["rows"]) for s in good]
        any_zero = any(min((r.get("hashrate") or 0) for r in s["rows"]) <= 0 for s in good)
        m = {"hash": sum(hashes) / n, "power": sum(powers) / n, "temp": max(temps), "rejected": rej[-1] - rej[0]}
        m["eff"] = m["hash"] / m["power"] if m["power"] else 0
        reason = None
        if not all(s["ok"] for s in good):
            reason = "miner yeniden başladı"
        elif any_zero:
            reason = "bir kartta hashrate 0"
        elif m["temp"] >= self.temp_limit:
            reason = f"sıcaklık {m['temp']:.0f}°C"
        elif m["rejected"] > 1:
            reason = f"{m['rejected']:.0f} red share"
        return m, reason

    # ---------- karar ----------
    def advance(self, t):
        """'apply' dönerse yeni değerler uygulanmalı; 'finish' dönerse iş bitti."""
        if self.finished:
            return "finish"
        if self.cancelled:
            self.current = dict(self.start_params)
            self.failed = "Kullanıcı iptal etti"
            self.finished = True
            return "finish"
        if t - self.step_started < self.step_sec:
            return None
        if len([s for s in self.samples if s]) < 2 and not any(s is None for s in self.samples):
            self.step_started = t - self.step_sec + 30  # yeterli örnek yok: biraz daha bekle
            return None
        m, problem = self._measure()
        if m is None:
            self.failed = f"Ayar durduruldu: {problem}. Başlangıç değerlerine dönüldü."
            self.current = dict(self.start_params)
            self.finished = True
            return "finish"
        stable = problem is None
        self.history.append({"phase": self.phase(), "params": dict(self.current),
                             "hash": round(m["hash"]), "power": round(m["power"], 1), "temp": round(m["temp"]), "ok": stable, "why": problem})
        self.steps += 1
        self._decide(m, stable)
        if self.steps >= self.max_steps:
            self.phase_i = len(self.phases)
        if self.phase() == "final":
            self.current = dict(self.good)
            self.finished = True
            return "finish"
        self._begin_step(t)
        return "apply"

    def _next_phase(self):
        self.phase_i += 1
        self.no_gain = 0
        self.current = dict(self.good)
        p = self.phase()
        if p == "mem":
            self._step_mem()
        elif p == "power":
            # Güç limiti ölçülen kart başı gücün %95'inden başlar
            per_card = (self.best["power"] / max(1, len(self.targets))) if self.best else 0
            if per_card <= 0:
                return self._next_phase()
            self.power_ref = per_card
            self.current["power_limit_w"] = int(per_card * 0.95)
            self.current = self._clamp(self.current)
        elif p == "core":
            self.current["core_offset"] = int(self.good.get("core_offset", 0)) - 100
            self.current = self._clamp(self.current)
        elif p == "voltage":
            self.current["core_mv"] = int(self.good.get("core_mv", 950)) - 25
            self.current = self._clamp(self.current)

    def _step_mem(self):
        key, step = ("mem_offset", 100) if self.vendor == "nvidia" else ("mem_clock", 25)
        nxt = self._clamp({key: int(self.current.get(key, 0)) + step})[key]
        if nxt == self.current.get(key):  # sınıra geldik
            return False
        self.current[key] = nxt
        return True

    def _accept(self, m):
        self.good = dict(self.current)
        self.best = m

    def _decide(self, m, stable):
        p = self.phase()
        if p == "baseline":
            if not stable:
                safe = self._clamp(preset_for(self.model, self.algo, self.vendor))
                if not self.fell_back and safe != self.start_params:
                    # Mevcut profil kararsız (ör. voltaj çok düşük): güvenli başlangıç değerleriyle yeniden ölç
                    self.fell_back = True
                    self.start_params = dict(safe)
                    self.current = dict(safe)
                    self.good = dict(safe)
                    return
                self.failed = "Güvenli başlangıç değerleriyle bile kararsız; kartı, riser'ı ve güç kablolarını kontrol edin."
                self.phase_i = len(self.phases)
                return
            self.baseline = m
            self._accept(m)
            self._next_phase()
            return
        if p == "mem":
            if stable and m["hash"] > self.best["hash"] * 1.003:
                self._accept(m)
                self.no_gain = 0
            elif stable:
                self.no_gain += 1
            if not stable or self.no_gain >= 2 or not self._step_mem():
                if not stable:
                    # Kararsız değerin hemen altı da sınırda olabilir: bir adım güvenlik payı bırak
                    key, step = ("mem_offset", 100) if self.vendor == "nvidia" else ("mem_clock", 25)
                    if self.good.get(key, 0) > self.start_params.get(key, 0):
                        self.good[key] = int(self.good[key]) - step
                self._next_phase()
            return
        if p in ("power", "core", "voltage"):
            # Verim artmalı ve hashrate en iyi değerin %98,5'inin altına düşmemeli
            better = stable and m["eff"] > self.best["eff"] * 1.002 and m["hash"] >= self.best["hash"] * 0.985
            if better:
                self._accept(m)
                if p == "power":
                    nxt = int(self.current["power_limit_w"] - self.power_ref * 0.05)
                    floor = int(self.power_ref * 0.6)
                    if nxt < floor:
                        return self._next_phase()
                    self.current["power_limit_w"] = nxt
                elif p == "core":
                    if self.current["core_offset"] <= int(self.start_params.get("core_offset", 0)) - 300:
                        return self._next_phase()
                    self.current["core_offset"] -= 100
                else:
                    self.current["core_mv"] -= 25
                prev = dict(self.current)
                self.current = self._clamp(self.current)
                if self.current == self.good or self.current != prev:
                    return self._next_phase()
            else:
                self._next_phase()

    # ---------- rapor ----------
    def cancel(self):
        self.cancelled = True

    def status(self):
        eta = max(0, int((len(self.phases) - self.phase_i) * 4 * self.step_sec - (time.time() - self.step_started)))
        return {"status": "running" if not self.finished else ("failed" if self.failed else "done"),
                "model": self.model, "algo": self.algo, "cards": len(self.targets), "phase": self.phase(),
                "step": self.steps, "current": self.current, "best": self.good,
                "best_hash": round(self.best["hash"]) if self.best else None,
                "best_power": round(self.best["power"], 1) if self.best else None,
                "baseline_hash": round(self.baseline["hash"]) if self.baseline else None,
                "baseline_power": round(self.baseline["power"], 1) if self.baseline else None,
                "eta_sec": eta, "message": self.failed}

    def result(self):
        r = {"model": self.model, "vendor": self.vendor, "algo": self.algo, "params": self.good, "steps": self.steps,
             "start_was_unstable": self.fell_back,
             "history": self.history[-25:]}
        if self.baseline and self.best:
            b, a = self.baseline, self.best
            r["before"] = {"hash": round(b["hash"]), "power": round(b["power"], 1)}
            r["after"] = {"hash": round(a["hash"]), "power": round(a["power"], 1)}
            def f(x):
                return f"{x / 1e6:.1f} MH/s"
            r["summary"] = (f"{len(self.targets)}× {self.model}: {f(b['hash'])} / {b['power']:.0f} W → "
                            f"{f(a['hash'])} / {a['power']:.0f} W (verim %{(a['eff'] / b['eff'] - 1) * 100:+.1f}). "
                            f"Önerilen: {', '.join(f'{k}={v}' for k, v in self.good.items())}"
                            + (" Not: mevcut profil kararsızdı, güvenli değerlerden başlandı." if self.fell_back else ""))
        return r
