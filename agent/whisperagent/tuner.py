"""Otomatik OC — KART BAŞINA: aynı model kartlar bile farklı değer kaldırır; her kart kendi en verimli kararlı değerini bulur.

Kartlar aynı anda ama her biri kendi değeriyle denenir (süre kart sayısıyla uzamaz). Her adım:
değerleri uygula → oturmasını bekle → her kartı ayrı ölç (hashrate, güç, sıcaklık, red, hashrate 0) → her kart kendi kararını verir.

Miner'ın tamamı çökerse (hangi kartın sebep olduğu belli değil) o adımda yeni değer deneyen kartlar İKİYE BÖLÜNEREK
yeniden denenir: denenmeyenler son sağlam değerlerinde bekler, suçlu kart bulunur ve sadece o geri çekilir.

NVIDIA aşamaları: taban ölçüm → bellek offset (+100) → güç limiti (-%5) → çekirdek offset (-100)
AMD aşamaları:    taban ölçüm → bellek saati (+25 MHz) → çekirdek voltajı (-25 mV)
Panel sınırları (bounds) asla aşılmaz. Sonuç bir öneridir; kullanıcı "Uygula" deyince her karta kendi değeri yazılır.
"""
import os
import time

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


class Card:
    """Tek bir kartın arama durumu."""

    def __init__(self, bus, idx, vendor, start, safe, clamp):
        self.bus, self.idx, self.vendor = bus, idx, vendor
        self.clamp = clamp
        self.safe = clamp(safe)
        self.start = clamp(start) if start else dict(self.safe)
        self.current = dict(self.start)   # denenen değer
        self.good = dict(self.start)      # son kararlı değer
        self.phases = ["baseline", "mem", "power", "core"] if vendor == "nvidia" else ["baseline", "mem", "voltage"]
        self.phase_i = 0
        self.no_gain = 0
        self.best = None
        self.baseline = None
        self.power_ref = None
        self.fell_back = False
        self.failed = None
        self.history = []

    @property
    def done(self):
        return self.phase_i >= len(self.phases)

    def phase(self):
        return self.phases[self.phase_i] if not self.done else "final"

    def _finish_with_good(self):
        self.phase_i = len(self.phases)
        self.current = dict(self.good)

    def fallback_to_safe(self):
        """Mevcut değer kararsız: güvenli başlangıca dön (tek sefer). Dönülemezse False."""
        if self.fell_back or self.safe == self.start:
            return False
        self.fell_back = True
        self.start = dict(self.safe)
        self.current = dict(self.safe)
        self.good = dict(self.safe)
        self.phase_i = 0
        return True

    def _accept(self, m):
        self.good = dict(self.current)
        self.best = m

    def _mem_key(self):
        return ("mem_offset", 100) if self.vendor == "nvidia" else ("mem_clock", 25)

    def _step_mem(self):
        key, step = self._mem_key()
        nxt = self.clamp({key: int(self.current.get(key, 0)) + step})[key]
        if nxt == self.current.get(key):
            return False
        self.current[key] = nxt
        return True

    def _next_phase(self):
        self.phase_i += 1
        self.no_gain = 0
        self.current = dict(self.good)
        p = self.phase()
        if p == "mem":
            if not self._step_mem():
                return self._next_phase()
        elif p == "power":
            if not self.best or not self.best["power"]:
                return self._next_phase()
            self.power_ref = self.best["power"]
            self.current["power_limit_w"] = int(self.power_ref * 0.95)
            self.current = self.clamp(self.current)
        elif p == "core":
            self.current["core_offset"] = int(self.good.get("core_offset", 0)) - 100
            self.current = self.clamp(self.current)
        elif p == "voltage":
            self.current["core_mv"] = int(self.good.get("core_mv", 950)) - 25
            self.current = self.clamp(self.current)

    def decide(self, m, stable, why=None):
        """Bir ölçüm sonucu: kararı ver, sıradaki denenecek değeri self.current'a koy."""
        self.history.append({"phase": self.phase(), "params": dict(self.current), "hash": round(m["hash"]) if m else 0,
                             "power": round(m["power"], 1) if m else 0, "ok": stable, "why": why})
        self.history = self.history[-12:]
        p = self.phase()
        if p == "baseline":
            if not stable:
                if not self.fallback_to_safe():
                    self.failed = f"Güvenli değerlerle bile kararsız ({why}); kartı, riser'ı ve kabloları kontrol edin."
                    self._finish_with_good()
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
                    key, step = self._mem_key()  # kararsızın hemen altı da sınırda olabilir: bir adım pay bırak
                    if self.good.get(key, 0) > self.start.get(key, 0):
                        self.good[key] = int(self.good[key]) - step
                self._next_phase()
            return
        # power / core / voltage: verim artmalı, hashrate en iyinin %98,5'inin altına düşmemeli
        better = stable and m["eff"] > self.best["eff"] * 1.002 and m["hash"] >= self.best["hash"] * 0.985
        if not better:
            return self._next_phase()
        self._accept(m)
        before = dict(self.current)
        if p == "power":
            nxt = int(self.current["power_limit_w"] - self.power_ref * 0.05)
            if nxt < int(self.power_ref * 0.6):
                return self._next_phase()
            self.current["power_limit_w"] = nxt
        elif p == "core":
            if self.current["core_offset"] <= int(self.start.get("core_offset", 0)) - 300:
                return self._next_phase()
            self.current["core_offset"] -= 100
        else:
            self.current["core_mv"] -= 25
        self.current = self.clamp(self.current)
        if self.current == before:  # sınıra geldik
            self._next_phase()


class Tuner:
    def __init__(self, cmd_id, payload, gpus, step_sec=None, t=None):
        self.cmd_id = cmd_id
        self.model = payload["model"]
        self.vendor = payload.get("vendor") or "nvidia"
        self.algo = payload.get("algo") or ""
        self.temp_limit = float(payload.get("temp_limit") or 80)
        self.bounds = payload.get("bounds") or {}
        self.step_sec = int(step_sec or os.environ.get("WM_TUNE_STEP_SEC") or 180)
        self.settle = max(5, int(self.step_sec * 0.35))
        safe = preset_for(self.model, self.algo, self.vendor)
        start_by_bus = payload.get("start_by_bus") or {}
        common = payload.get("start")  # eski biçim: tüm kartlar için tek başlangıç
        self.cards = {}
        for g in gpus:
            if g["model"] != self.model:
                continue
            start = start_by_bus.get(g["bus_id"]) if g["bus_id"] in start_by_bus else common
            self.cards[g["bus_id"]] = Card(g["bus_id"], g.get("index", 0), self.vendor, start or None, safe, self._clamp)
        self.targets = list(self.cards)
        self.mode = "parallel"
        self.isolate_queue = []   # sırayla denenecek kart grupları
        self.iso = None           # şu an tek başına denenen grup (bus listesi)
        self.steps = 0
        self.max_steps = 80
        self.finished = False
        self.failed = None
        self.cancelled = False
        self.global_fallback = False
        self._begin_step(t or time.time())

    def _clamp(self, p):
        out = {}
        for k, v in (p or {}).items():
            if v is None:
                continue
            lo, hi = (self.bounds.get(k) or [-10**6, 10**6])
            out[k] = int(min(hi, max(lo, round(float(v)))))
        return out

    def _begin_step(self, t):
        self.step_started = t
        self.samples = []
        self.restarts_at_start = None

    def active(self):
        return [c for c in self.cards.values() if not c.done]

    # ---------- agent'a uygulanacak değerler ----------
    def wanted_params_by_bus(self):
        out = {}
        for bus, c in self.cards.items():
            if c.done:
                out[bus] = dict(c.good)
            elif self.mode == "isolate":
                out[bus] = dict(c.current if bus in self.iso else c.good)
            else:
                out[bus] = dict(c.current)
        return out

    # ---------- ölçüm ----------
    def feed(self, rows, miners_ok, restarts, t=None):
        if self.finished:
            return
        if self.restarts_at_start is None:
            self.restarts_at_start = restarts
        if (t or time.time()) - self.step_started < self.settle:
            return
        by = {r["bus_id"]: r for r in rows}
        if any(b not in by for b in self.cards):
            self.samples.append(None)  # kart kayboldu
            return
        self.samples.append({"rows": {b: by[b] for b in self.cards}, "ok": miners_ok and restarts == self.restarts_at_start})

    def _card_measure(self, bus, good):
        rs = [s["rows"][bus] for s in good]
        n = len(rs)
        m = {"hash": sum(r.get("hashrate") or 0 for r in rs) / n, "power": sum(r.get("power") or 0 for r in rs) / n,
             "temp": max((r.get("temp") or 0) for r in rs),
             "rejected": (rs[-1].get("rejected") or 0) - (rs[0].get("rejected") or 0)}
        m["eff"] = m["hash"] / m["power"] if m["power"] else 0
        why = None
        if min((r.get("hashrate") or 0) for r in rs) <= 0:
            why = "hashrate 0"
        elif m["temp"] >= self.temp_limit:
            why = f"sıcaklık {m['temp']:.0f}°C"
        elif m["rejected"] > 1:
            why = f"{m['rejected']:.0f} red share"
        return m, why

    # ---------- karar ----------
    def advance(self, t):
        if self.finished:
            return "finish"
        if self.cancelled:
            for c in self.cards.values():
                c.good = dict(c.start)
            self.failed = "Kullanıcı iptal etti"
            self.finished = True
            return "finish"
        # Miner çöktüyse sonucu beklemeye gerek yok: adım hemen değerlendirilir (sadece kararlılık tam süre ister)
        crashed = any(s is not None and not s["ok"] for s in self.samples)
        if t - self.step_started < self.step_sec and not crashed:
            return None
        if any(s is None for s in self.samples):
            self.failed = "Ayar durduruldu: bir kart kayboldu (çökmüş olabilir). Kartlar eski değerlerine döndü."
            for c in self.cards.values():
                c.good = dict(c.start)
            self.finished = True
            return "finish"
        good = [s for s in self.samples if s]
        if len(good) < 2 and not crashed:
            self.step_started = t - self.step_sec + 30  # yeterli örnek yok: biraz daha bekle
            return None
        global_ok = all(s["ok"] for s in good)
        self.steps += 1

        if self.mode == "isolate":
            group = [self.cards[b] for b in self.iso]
            if global_ok:
                # Bu gruptakiler birlikte kararlı: her kart kendi ölçümüyle karar verir
                for c in group:
                    m, why = self._card_measure(c.bus, good)
                    c.decide(m, why is None, why)
            elif len(group) == 1:
                m, why = self._card_measure(group[0].bus, good)
                group[0].decide(m, False, "miner çöktü")  # suçlu bulundu
            else:
                half = len(group) // 2  # suçlu bu grupta: ikiye bölüp ayrı ayrı dene
                self.isolate_queue[:0] = [[c.bus for c in group[:half]], [c.bus for c in group[half:]]]
            self._next_isolate()
        elif not global_ok:
            self._handle_global_crash()
        else:
            for c in self.active():
                m, why = self._card_measure(c.bus, good)
                c.decide(m, why is None, why)

        if self.failed:
            self.finished = True
            return "finish"
        if not self.active() or self.steps >= self.max_steps:
            for c in self.cards.values():
                c._finish_with_good()
            self.finished = True
            return "finish"
        self._begin_step(t)
        return "apply"

    def _handle_global_crash(self):
        trying = [c for c in self.active() if c.current != c.good]
        if not trying:
            # Herkes başlangıç/son sağlam değerindeyken bile çöküyor: herkesi bir kez güvenli değerlere al
            if not self.global_fallback:
                self.global_fallback = True
                if not any([c.fallback_to_safe() for c in self.active()]):
                    self.failed = "Güvenli değerlerle bile miner çöküyor; kartları ve güç beslemesini kontrol edin."
                return
            self.failed = "Güvenli değerlerle bile miner çöküyor; kartları ve güç beslemesini kontrol edin."
            return
        # Suçlu belli değil: yeni değer deneyen kartları ikiye bölerek dene (8 kartta ~3 adımda bulunur),
        # denenmeyenler son sağlam değerinde bekler
        half = len(trying) // 2
        self.isolate_queue = [g for g in ([c.bus for c in trying[:half]], [c.bus for c in trying[half:]]) if g]
        self.mode = "isolate"
        self._next_isolate()

    def _next_isolate(self):
        while self.isolate_queue:
            group = [b for b in self.isolate_queue.pop(0) if not self.cards[b].done]
            if group:
                self.iso = group
                return
        self.iso = None
        self.mode = "parallel"

    # ---------- rapor ----------
    def cancel(self):
        self.cancelled = True

    def _totals(self, key):
        vals = [getattr(c, key) for c in self.cards.values()]
        if any(v is None for v in vals):
            return None
        return {"hash": sum(v["hash"] for v in vals), "power": sum(v["power"] for v in vals)}

    def status(self):
        remaining = max((len(c.phases) - c.phase_i for c in self.cards.values()), default=0)
        eta = max(0, int((remaining * 3 + len(self.isolate_queue)) * self.step_sec - (time.time() - self.step_started)))
        before, best = self._totals("baseline"), self._totals("best")
        return {
            "status": "running" if not self.finished else ("failed" if self.failed else "done"),
            "model": self.model, "algo": self.algo, "cards": len(self.cards), "per_card": True,
            "mode": self.mode, "isolating": [self.cards[b].idx for b in self.iso] if self.iso else None, "step": self.steps,
            "baseline_hash": round(before["hash"]) if before else None, "baseline_power": round(before["power"], 1) if before else None,
            "best_hash": round(best["hash"]) if best else None, "best_power": round(best["power"], 1) if best else None,
            "eta_sec": eta, "message": self.failed,
            "card_list": [{"bus_id": c.bus, "idx": c.idx, "phase": c.phase(), "current": c.current, "good": c.good,
                           "hash": round(c.best["hash"]) if c.best else None, "done": c.done} for c in self.cards.values()],
        }

    def result(self):
        cards = []
        for c in self.cards.values():
            item = {"bus_id": c.bus, "idx": c.idx, "params": c.good, "start_was_unstable": c.fell_back, "failed": c.failed}
            if c.baseline and c.best:
                item["before"] = {"hash": round(c.baseline["hash"]), "power": round(c.baseline["power"], 1)}
                item["after"] = {"hash": round(c.best["hash"]), "power": round(c.best["power"], 1)}
            cards.append(item)
        r = {"model": self.model, "vendor": self.vendor, "algo": self.algo, "steps": self.steps, "cards": cards}
        before, after = self._totals("baseline"), self._totals("best")
        if before and after and before["power"] and after["power"]:
            r["before"], r["after"] = {k: round(v, 1) for k, v in before.items()}, {k: round(v, 1) for k, v in after.items()}
            eff = (after["hash"] / after["power"]) / (before["hash"] / before["power"]) - 1
            r["summary"] = (f"{len(cards)}× {self.model}: {before['hash'] / 1e6:.1f} MH/s / {before['power']:.0f} W → "
                            f"{after['hash'] / 1e6:.1f} MH/s / {after['power']:.0f} W (verim %{eff * 100:+.1f}), her kart kendi değeriyle.")
        return r
