"""Ana döngü."""
import json
import logging
import os
import re
import socket
import subprocess
import threading
import time

from . import VERSION, config, console, display, oc, updater
from .tuner import Tuner
from .api import Api, ApiError
from .hw import backend
from .miners import SPECS, MinerError, MinerProcess, download_miner
from .util import log, run

HANG_LIMIT_SEC = 20 * 60  # miner indirme yavaş internette uzun sürebilir; bundan uzun takılma gerçek kilitlenmedir
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\r")

# Bazı algoritmalar her kartta çalışmaz. Pearl (pearlhash) tensor çekirdeği ister: NVIDIA RTX 20 ve sonrası,
# AMD'de sadece RDNA2 (RX 6600–6950). P106/GTX 10xx ve RX 4xx/5xx bu algoritmayı kazamaz.
ALGO_CARDS = {
    "pearl": lambda g: (g["vendor"] == "nvidia" and not re.search(r"P10[0246]|GTX (9|10)\d\d|TITAN X|Quadro P", g["model"], re.I))
    or (g["vendor"] == "amd" and bool(re.search(r"RX 6[6-9]\d\d", g["model"]))),
    # Quantus (QPoW): NVIDIA RTX 30 ve sonrası, AMD RDNA (RX 6000/7000/9000)
    "quantus": lambda g: (g["vendor"] == "nvidia" and bool(re.search(r"RTX [3-9]\d{3}|RTX A\d|\b[AHLB]\d{2,3}\b", g["model"], re.I)))
    or (g["vendor"] == "amd" and bool(re.search(r"RX [679]\d{3}", g["model"]))),
}
ALGO_NAMES = {"pearl": "Pearl (RTX 20 ve üstü NVIDIA ya da RX 6600–6950 gerekir)",
              "quantus": "Quantus (RTX 30 ve üstü NVIDIA ya da RX 6000 ve üstü AMD gerekir)"}


def algo_supported(algo, gpu):
    check = ALGO_CARDS.get(algo)
    return check(gpu) if check else True


def tail_lines(path, n):
    """Dosyanın son n satırı, renk kodları temizlenmiş (panelde düz yazı gösterilir)."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 24000))
            text = f.read().decode(errors="replace")
    except OSError:
        return []
    return [ANSI.sub("", line) for line in text.splitlines()[-n:]]


STOP_FLAG = os.path.join(config.STATE_DIR, "miner-stopped")   # kullanıcı durdurduysa açılışta da başlatma
MINER_CACHE = os.path.join(config.STATE_DIR, "miners")


class Agent:
    def __init__(self):
        self.conf = config.read_conf()
        self.server = (self.conf.get("SERVER_URL") or config.DEFAULT_SERVER_URL).rstrip("/")
        self.api = Api(self.server)
        self.hw = backend()
        self.fake = hasattr(self.hw, "mining")
        self.fingerprint = config.hw_fingerprint()
        self.gpus = []
        self.paired = False
        self.poll = 10
        self.config_version = None
        self.cfg = None
        self.fs_signature = None
        self.oc_signature = None
        self.miners = []          # [(spec, MinerProcess, gpus)]
        self.miner_state = "stopped"
        self.error = None
        self.hw_problem = None     # takılı ama sürücünün göremediği kart varsa açıklaması
        self.download_retry_at = 0
        self.alive_at = time.monotonic()  # ana döngünün son ilerlediği an (bekçi için)
        self.last_hw_scan = 0
        self.next_update_check = time.monotonic() + 120
        self.view = {"server": self.server}
        self.tuner = None          # çalışan otomatik OC (varsa)
        self.want_screen = False   # panelde biri rig ekranını izliyor
        self.last_rows = []

    # ---------- kimlik ----------
    def identity(self):
        rid, secret = self.conf.get("RIG_ID"), self.conf.get("RIG_SECRET")
        if rid and secret:
            self.api.set_credentials(rid, secret)
            return
        # rig.conf'ta kimlik yok: kayıt ol, ekrana eşleştirme kodu yaz (monitörlü rig yöntemi)
        r = self.api.register(self.fingerprint, socket.gethostname()[:32], self.hw.system().get("os_info", ""))
        self.conf.update({"RIG_ID": r["rig_id"], "RIG_SECRET": r["rig_secret"], "SERVER_URL": self.server, "SOURCE": "agent"})
        try:
            config.write_conf(self.conf)
        except OSError as e:
            log.error("rig.conf yazılamadı: %s", e)
        self.api.set_credentials(r["rig_id"], r["rig_secret"])
        self.view["pairing_code"] = r["pairing_code"]
        log.info("Kayıt olundu. Eşleştirme kodu: %s", r["pairing_code"])

    def on_unauthorized(self):
        self.paired = False
        if self.conf.get("SOURCE") == "agent":
            log.warning("Kimlik geçersiz (rig panelden silinmiş). Yeniden kayıt olunuyor.")
            for k in ("RIG_ID", "RIG_SECRET", "SOURCE"):
                self.conf.pop(k, None)
            self.api.set_credentials(None, None)
            self.identity()
        else:
            self.view["connection"] = "rig.conf geçersiz"
            self.error = "rig.conf geçersiz: panelden yeni rig.conf indirip flash belleğe kopyalayın."
            log.error(self.error)
            time.sleep(15)
            self.conf = config.read_conf()  # kullanıcı dosyayı değiştirmiş olabilir
            self.api.set_credentials(self.conf.get("RIG_ID"), self.conf.get("RIG_SECRET"))

    # ---------- donanım ----------
    def hardware_payload(self):
        sysinfo = self.hw.system()
        return {"hw_fingerprint": self.fingerprint, "agent_version": VERSION, "os_info": sysinfo.get("os_info"),
                "cpu_model": sysinfo.get("cpu_model"), "ram_total_mb": sysinfo.get("ram_total_mb"),
                "gpus": [{k: g.get(k) for k in ("index", "bus_id", "vendor", "model", "vram_mb", "driver", "vbios", "uuid")}
                         for g in self.gpus]}

    def rescan(self, force=False):
        gpus = self.hw.scan()
        changed = [g["bus_id"] + g["model"] for g in gpus] != [g["bus_id"] + g["model"] for g in self.gpus]
        self.gpus = gpus
        self.last_hw_scan = time.monotonic()
        problem = getattr(self.hw, "problem", None)
        hw_problem = problem(gpus) if problem else None
        if hw_problem != self.hw_problem:
            if hw_problem:
                log.error("Kart sorunu: %s", hw_problem)
            self.hw_problem = hw_problem
        if changed or force:
            log.info("Kartlar: %s", ", ".join(f"{g['bus_id']} {g['model']}" for g in gpus) or "yok")
            self.api.hardware(self.hardware_payload())
            if changed and self.cfg:
                self.fs_signature = None  # kart listesi değişti: miner'lar yeniden kurulsun
        return changed

    # ---------- miner ----------
    def stop_miners(self):
        for _spec, proc, _g in self.miners:
            proc.stop()
        self.miners = []
        if self.fake:
            self.hw.mining.clear()

    def build_miners(self):
        """Flight sheet'e göre miner'ları hazırla (gerekirse indir). Hata olursa self.error doldurulur."""
        self.stop_miners()
        fs = (self.cfg or {}).get("flight_sheet")
        if not fs:
            self.miner_state = "stopped"
            return
        built = []
        skipped = []
        for m in fs.get("miners", []):
            spec = SPECS.get(m.get("api_type"))
            if not spec:
                self.error = f"Desteklenmeyen miner: {m.get('name')}"
                continue
            vendors = [v for v in spec.vendors if m.get("gpu_vendor") in ("all", v)]
            gpus = [g for g in self.gpus if g["vendor"] in vendors and algo_supported(fs["algo"], g)]
            skipped += [g for g in self.gpus if g["vendor"] in vendors and not algo_supported(fs["algo"], g)]
            if not gpus:
                continue  # bu rig'de bu miner'ın (ya da bu algoritmanın) kartı yok
            self.miner_state = "downloading"
            self.send_stats_safe()
            binary = download_miner(spec, m, MINER_CACHE)
            env = None
            if any(s["vendor"] == "nvidia" for s in skipped) and any(g["vendor"] == "nvidia" for g in gpus):
                # Desteklemeyen NVIDIA kartları miner'dan gizle (CUDA sırası PCI sırasıyla aynı olsun)
                env = dict(os.environ, CUDA_DEVICE_ORDER="PCI_BUS_ID",
                           CUDA_VISIBLE_DEVICES=",".join(str(g["index"]) for g in gpus if g["vendor"] == "nvidia"))
            if self.fake:
                env = dict(env or os.environ, WM_FAKE_BUSES=",".join(g["bus_id"] for g in gpus), WM_FAKE_ALGO=fs["algo"])
            log_path = os.path.join(config.RUN_DIR, f"miner-{spec.api_type}.log")
            built.append((spec, MinerProcess(spec, binary, spec.args(fs, m, gpus), log_path, env), gpus))
        self.miners = built
        self.error = None
        if skipped:
            names = ", ".join(sorted({g["model"] for g in skipped}))
            note = f"{ALGO_NAMES.get(fs['algo'], fs['algo'])}: bu kartlar kazamaz, boşta kalır: {names}"
            log.warning(note)
            if not built:
                self.miner_state = "error"
                self.error = note
                return
        if os.path.exists(STOP_FLAG):
            self.miner_state = "stopped"
        else:
            self.start_miners()

    def start_miners(self):
        if not self.miners:
            self.miner_state = "stopped"
            return False
        for _spec, proc, gpus in self.miners:
            if not proc.running():
                proc.start()
            if self.fake:
                self.hw.mining.update(g["bus_id"] for g in gpus)
        self.miner_state = "starting"
        return True

    def watchdog(self):
        if not self.miners or os.path.exists(STOP_FLAG):
            return
        states = [proc.watchdog() for _s, proc, _g in self.miners]
        if all(s == "running" for s in states):
            up = min(p.uptime() for _s, p, _g in self.miners)
            self.miner_state = "running" if up >= 5 else "starting"
            if up >= 60:
                self.error = None  # bir dakikadır sorunsuz: eski çökme mesajını temizle
        elif "error" in states:
            self.miner_state = "error"
            bad = next(p for (_s, p, _g), st in zip(self.miners, states) if st == "error")
            self.error = f"{bad.spec.name} kapandı (kod {bad.last_exit}). Son satır: {' | '.join(bad.tail(2))[:200]}"
        else:
            self.miner_state = "starting"

    # ---------- OC ----------
    def effective_overclock(self):
        items = list((self.cfg or {}).get("overclock") or [])
        if self.tuner and not self.tuner.finished:
            wanted = self.tuner.wanted_params_by_bus()  # her kartın kendi denenen değeri
            items = [dict(i, params=wanted[i["bus_id"]], profile="otomatik OC") if i.get("bus_id") in wanted else i for i in items]
        return items

    def apply_oc(self):
        return oc.apply_all(self.gpus, self.effective_overclock(), self.hw if self.fake else None)

    # ---------- ayarlar ----------
    def apply_config(self):
        self.cfg = self.api.config()
        self.config_version = self.cfg.get("config_version")
        self.view["rig_name"] = self.cfg.get("rig_name")
        oc_sig = json.dumps(self.cfg.get("overclock"), sort_keys=True)
        if oc_sig != self.oc_signature:
            self.oc_signature = oc_sig
            self.apply_oc()  # otomatik OC sürüyorsa onun kartlarına dokunulmaz
        fs_sig = json.dumps(self.cfg.get("flight_sheet"), sort_keys=True)
        if fs_sig != self.fs_signature:
            self.fs_signature = fs_sig
            try:
                self.build_miners()
            except (MinerError, OSError, ValueError) as e:
                self.miner_state = "error"
                self.error = str(e)
                self.download_retry_at = time.monotonic() + 300
                log.error("Miner hazırlanamadı: %s", e)

    # ---------- komutlar ----------
    BASIC_COMMANDS = ("miner_start", "miner_stop", "miner_restart", "apply_oc")

    def exec_basic(self, ctype):
        """Panelden ve rig'in kendi ekranından (wm / miner komutları) gelen ortak komutlar → (durum, kod, çıktı)."""
        if ctype == "miner_start":
            if os.path.exists(STOP_FLAG):
                os.remove(STOP_FLAG)
            if not self.miners and self.cfg and self.cfg.get("flight_sheet"):
                self.build_miners()
            if self.start_miners():
                return "done", 0, "Miner başlatıldı"
            return "failed", 1, self.error or "Flight sheet atanmamış ya da uygun kart yok"
        if ctype == "miner_stop":
            os.makedirs(config.STATE_DIR, exist_ok=True)
            open(STOP_FLAG, "w").close()
            for _s, proc, _g in self.miners:
                proc.stop()
            if self.fake:
                self.hw.mining.clear()
            self.miner_state = "stopped"
            return "done", 0, "Miner durduruldu"
        if ctype == "miner_restart":
            if os.path.exists(STOP_FLAG):
                os.remove(STOP_FLAG)
            self.fs_signature = None
            self.apply_config()
            return "done", 0, "Miner yeniden başlatıldı" if self.miners else (self.error or "Çalıştırılacak miner yok")
        if ctype == "apply_oc":
            return "done", 0, "; ".join(self.apply_oc()) or "OC listesi boş"
        return "failed", 1, f"Bilinmeyen komut: {ctype}"

    # Panelin rig ekranından yazılabilen tanı komutları: sabit program + argüman, kabuk yok
    DIAG = {
        "nvidia-smi": ["nvidia-smi"],
        "clinfo": ["clinfo", "-l"],
        "uptime": ["uptime"],
        "df": ["df", "-h", "/", "/wmining"],
        "free": ["free", "-m"],
        "ip": ["ip", "-br", "addr"],
        "ping": ["ping", "-c", "3", "-W", "2", "1.1.1.1"],
        "lspci": ["lspci"],
        "dmesg": ["dmesg", "--ctime"],
    }

    def console_exec(self, cmd):
        """Rig ekranından gelen komut → (durum, kod, çıktı)."""
        basic = {"miner start": "miner_start", "miner stop": "miner_stop", "miner restart": "miner_restart", "oc": "apply_oc"}
        if cmd in basic:
            return self.exec_basic(basic[cmd])
        if cmd == "miner log":
            lines = []
            for _s, proc, _g in self.miners:
                lines += [f"── {proc.spec.name} ──"] + tail_lines(proc.log_path, 60)
            return "done", 0, "\n".join(lines) or "Miner çalışmıyor"
        if cmd == "log":
            return "done", 0, "\n".join(tail_lines(os.path.join(config.RUN_DIR, "agent.log"), 60))
        if cmd == "miner api":  # miner'ın ham verisi: hashrate/share okunamıyorsa sebebi buradan görülür
            from .miners.specs import _http_json
            parts = []
            for spec, proc, _g in self.miners:
                for path in getattr(spec, "api_paths", ("/",)):
                    try:
                        parts.append(f"── {spec.name} {path} ──\n{json.dumps(_http_json(spec.port, path), ensure_ascii=False)[:4000]}")
                    except Exception as e:
                        parts.append(f"── {spec.name} {path} ── okunamadı: {e}")
            return "done", 0, "\n".join(parts) or "Miner çalışmıyor"
        if cmd == "bilgi":
            return "done", 0, (f"Rig: {self.view.get('rig_name')}\nRig ID: {self.api.rig_id}\nPanel: {self.server}\n"
                               f"Agent: {VERSION}\nKartlar: {', '.join(g['model'] for g in self.gpus) or 'yok'}")
        if cmd == "guncelle":
            self.next_update_check = 0
            return "done", 0, "Güncelleme kontrolü birkaç saniye içinde yapılacak"
        argv = self.DIAG.get(cmd)
        if not argv:
            return "failed", 1, f"Bilinmeyen komut: {cmd}"
        code, out = run(argv, timeout=20)  # takılan nvidia-smi agent'ı kilitlemesin
        if code == 127:
            return "failed", 1, f"{argv[0]} bu sistemde yok"
        if code == 124:
            return "failed", 1, f"{cmd} 20 sn içinde bitmedi (sürücü yanıt vermiyor olabilir)"
        out = ANSI.sub("", out)
        if cmd == "lspci":
            out = "\n".join(l for l in out.splitlines() if any(k in l for k in ("VGA", "3D", "Display"))) or out
        if cmd == "dmesg":
            lines = out.splitlines()
            gpu = [l for l in lines if re.search(r"NVRM|nvidia|amdgpu|BAR \d|no space for|can't claim", l, re.I)]
            out = "\n".join(gpu[-40:] + ["── son satırlar ──"] + lines[-20:]) if gpu else "\n".join(lines[-40:])
        return ("done" if code == 0 else "failed"), code, out[-11000:] or "(çıktı yok)"

    def reboot_now(self):
        self.stop_miners()
        self.miner_state = "stopped"
        self.fs_signature = None  # yeniden başlatma olmazsa sonraki turda miner'lar tekrar kurulsun
        if self.fake:
            log.info("(simülasyon) yeniden başlatma atlandı")
        else:
            subprocess.run(["systemctl", "reboot"], check=False)

    def local_commands(self):
        """Rig'in kendi ekranında yazılan komutlar (wm, miner, sreboot) RUN_DIR/cmd üzerinden gelir."""
        d = os.path.join(config.RUN_DIR, "cmd")
        try:
            names = sorted(n for n in os.listdir(d) if n.endswith(".json"))
        except OSError:
            return
        for name in names:
            path = os.path.join(d, name)
            try:
                with open(path, encoding="utf-8") as f:
                    ctype = json.load(f).get("type")
                os.remove(path)
            except (OSError, ValueError):
                continue
            log.info("Yerel komut: %s", ctype)
            try:
                if ctype == "reboot":
                    res = ("done", 0, "Yeniden başlatılıyor")
                elif ctype == "update":
                    self.next_update_check = 0
                    res = ("done", 0, "Güncelleme kontrolü birkaç saniye içinde yapılacak")
                else:
                    res = self.exec_basic(ctype)
            except Exception as e:  # komut hatası agent'ı düşürmesin
                res = ("failed", 1, f"Hata: {e}")
            try:
                with open(path[:-5] + ".out", "w", encoding="utf-8") as f:
                    json.dump({"status": res[0], "output": res[2]}, f, ensure_ascii=False)
            except OSError:
                pass
            if ctype == "reboot":
                self.reboot_now()

    def run_commands(self):
        for c in self.api.commands():
            ctype, status, code, out = c["type"], "done", 0, ""
            log.info("Komut: %s", ctype)
            try:
                if ctype in self.BASIC_COMMANDS:
                    status, code, out = self.exec_basic(ctype)
                elif ctype == "console":
                    cmd = str((c.get("payload") or {}).get("cmd") or "")
                    if cmd == "sreboot":
                        self.api.command_result(c["id"], "done", 0, "Yeniden başlatılıyor")
                        self.reboot_now()
                        continue
                    status, code, out = self.console_exec(cmd)
                elif ctype == "oc_tune":
                    if self.tuner and not self.tuner.finished:
                        status, code, out = "failed", 1, "Zaten bir otomatik OC çalışıyor"
                    elif self.miner_state != "running":
                        status, code, out = "failed", 1, "Miner çalışmıyor; otomatik OC hashrate ölçerek çalışır"
                    else:
                        payload = c.get("payload") or {}
                        self.tuner = Tuner(c["id"], payload, self.gpus)
                        if not self.tuner.targets:
                            self.tuner = None
                            status, code, out = "failed", 1, f"Bu rig'de {payload.get('model')} yok"
                        else:
                            log.info("Otomatik OC başladı: %s (%d kart)", self.tuner.model, len(self.tuner.targets))
                            self.apply_oc()
                            continue  # sonuç iş bitince bildirilir
                elif ctype == "oc_tune_cancel":
                    if self.tuner and not self.tuner.finished:
                        self.tuner.cancel()
                        out = "İptal ediliyor; başlangıç değerlerine dönülecek"
                    else:
                        out = "Çalışan otomatik OC yok"
                elif ctype == "reboot":
                    self.api.command_result(c["id"], "done", 0, "Yeniden başlatılıyor")
                    self.reboot_now()
                    continue
                else:
                    status, code, out = "failed", 1, f"Bilinmeyen komut: {ctype}"
            except Exception as e:  # komut hatası agent'ı düşürmesin
                status, code, out = "failed", 1, f"Hata: {e}"
            self.api.command_result(c["id"], status, code, out)

    # ---------- istatistik ----------
    def collect(self):
        sensors = self.hw.sensors()
        mined = {}
        for spec, proc, gpus in self.miners:
            if proc.running():
                try:
                    mined.update(spec.stats(gpus))
                except Exception:  # miner API'si henüz hazır değil
                    pass
        rows = []
        for g in self.gpus:
            s = dict(sensors.get(g["bus_id"], {}))
            s.update({k: v for k, v in mined.get(g["bus_id"], {}).items() if v is not None})
            s.setdefault("hashrate", 0)
            if self.fake:
                s["hashrate"] = self.hw.fake_hash(g["bus_id"], s["hashrate"])  # sahte kart OC'ye tepki verir
            rows.append({"bus_id": g["bus_id"], **s})
        if not any(p.running() for _s, p, _g in self.miners) and self.miner_state in ("running", "starting"):
            self.miner_state = "stopped"
        uptime = min((p.uptime() for _s, p, _g in self.miners), default=0)
        sysinfo = self.hw.system()
        self.view["gpus"] = [{**g, **r} for g, r in zip(self.gpus, rows)]
        return {"miner": {"status": self.miner_state, "uptime_sec": uptime, "error": self.error or self.hw_problem},
                "system": {"cpu_load": sysinfo.get("cpu_load"), "ram_used_mb": sysinfo.get("ram_used_mb")},
                "gpus": rows}

    def step_tuner(self):
        act = self.tuner.advance(time.monotonic())
        if act == "apply":
            log.info("Otomatik OC adım %d (%s): %s", self.tuner.steps, self.tuner.mode,
                     "; ".join(f"{b}={p}" for b, p in self.tuner.wanted_params_by_bus().items()))
            self.apply_oc()
        elif act == "finish":
            t = self.tuner
            self.tuner = None
            self.apply_oc()  # kartlar panelde atanmış değerlere döner; öneriyi kullanıcı uygular
            if t.failed:
                log.warning("Otomatik OC bitti: %s", t.failed)
                self.api.command_result(t.cmd_id, "failed", 1, t.failed)
            else:
                r = t.result()
                log.info("Otomatik OC bitti: %s", r.get("summary"))
                self.api.command_result(t.cmd_id, "done", 0, json.dumps(r))

    def send_stats_safe(self):
        try:
            return self.api.stats(self.collect())
        except Exception as e:
            log.warning("İstatistik gönderilemedi: %s", e)
            return None

    # ---------- döngü ----------
    def tick(self):
        if not self.paired:
            st = self.api.status()
            self.view["rig_name"] = st.get("rig_name")
            if not st.get("paired"):
                self.view["pairing_code"] = st.get("pairing_code")
                self.view["connection"] = "eşleştirme bekleniyor"
                if not self.gpus:
                    self.rescan(force=True)
                display.show(self.view)
                time.sleep(5)
                return
            self.paired = True
            self.view.pop("pairing_code", None)
            self.view["connection"] = "bağlı"
            self.error = None
            updater.confirm_healthy()
            self.poll = int(st.get("poll_interval_sec") or 10)
            self.rescan(force=True)
            log.info("Panele bağlandı: %s", st.get("rig_name"))

        if time.monotonic() - self.last_hw_scan > 60:
            self.rescan()
        if self.error and self.miner_state == "error" and time.monotonic() > self.download_retry_at and not self.miners:
            self.fs_signature = None  # indirme hatası: 5 dakikada bir tekrar dene

        payload = self.collect()
        if self.tuner:
            restarts = sum(p.restarts for _s, p, _g in self.miners)
            miners_ok = bool(self.miners) and all(p.running() for _s, p, _g in self.miners)
            self.tuner.feed(payload["gpus"], miners_ok, restarts)
            payload["tune"] = self.tuner.status()
        if self.want_screen:
            payload["screen"] = self.screen_payload()
        res = self.api.stats(payload)
        self.want_screen = bool(res.get("want_screen"))
        self.view["connection"] = "bağlı"
        if self.tuner:
            self.step_tuner()
        if res.get("hardware_required"):
            self.rescan(force=True)
        if res.get("config_version") != self.config_version or self.fs_signature is None:
            self.apply_config()
        if res.get("pending_commands"):
            self.run_commands()
        self.poll = int(res.get("poll_interval_sec") or self.poll)

        # Otomatik OC sürerken güncelleme yapılmaz: yeniden başlama yarım kalan denemeyi kaybettirir
        if time.monotonic() > self.next_update_check and not self.tuner:
            self.next_update_check = time.monotonic() + 6 * 3600
            self.check_update()

        self.refresh_screen()
        self.wait_poll()

    def wait_poll(self):
        """Bekleme sırasında miner'ları izle. Monotonik saat: açılışta saat internetten düzeltilince
        (BIOS saati yerel saatteyse 3 saat geri atlar) bekleme uzamaz."""
        until = time.monotonic() + self.poll
        next_screen = time.monotonic() + 3
        while time.monotonic() < until:
            self.watchdog()
            self.local_commands()
            if time.monotonic() >= next_screen:
                next_screen = time.monotonic() + 3
                self.refresh_screen()
            time.sleep(1)

    def screen_payload(self):
        """Panelde 'Ekranı göster': canlı ekranın düz yazısı + miner çıktısının son satırları."""
        lines = []
        for _s, proc, _g in self.miners:
            lines += [f"── {proc.spec.name} ──"] + tail_lines(proc.log_path, 60)
        log_text = "\n".join(lines)[-15000:]
        return {"text": display.render(self.view), "log": log_text}

    def refresh_screen(self):
        """Monitördeki canlı ekran (HiveOS gibi): kart kart hashrate, sıcaklık, share; her 3 sn'de bir."""
        try:
            self.collect()
        except Exception as e:  # sensör okunamadı: ekran eski veriyle kalsın
            log.debug("Ekran verisi okunamadı: %s", e)
        fs = (self.cfg or {}).get("flight_sheet") or {}
        self.view["flight"] = {"coin": fs.get("coin"), "algo": fs.get("algo"), "pool": (fs.get("pools") or [None])[0],
                               "miners": [s.name for s, _p, _g in self.miners]}
        self.view["uptime"] = min((p.uptime() for _s, p, _g in self.miners), default=0)
        self.view["miner"] = {"running": "çalışıyor", "starting": "başlıyor", "downloading": "indiriliyor",
                              "stopped": "durduruldu", "error": "hata"}.get(self.miner_state, self.miner_state)
        self.view["error"] = self.error or self.hw_problem
        self.view["tune"] = self.tuner.status() if self.tuner else None
        display.show(self.view)

    def check_update(self):
        if self.fake or os.environ.get("WM_NO_UPDATE") == "1":
            return
        try:
            info = self.api.update()
            if info.get("update_available"):
                self.stop_miners()
                updater.install(info)
                raise SystemExit(0)  # systemd yeni sürümle yeniden başlatır
        except SystemExit:
            raise
        except Exception as e:
            log.warning("Güncelleme kontrolü başarısız: %s", e)

    def wait_conf_partition(self):
        """WMINING bölümü bağlanmadan rig.conf okunmaz; okunmadan kayıt olmak yanlış rig yaratır.
        Yavaş USB bellekler açılışta geç görünebilir: bağlanana kadar bekle, arada bağlamayı dene."""
        waited = 0
        while not config.conf_partition_ready():
            if waited % 15 == 0:
                run(["mount", config.FAT_MOUNT], timeout=30)
            if waited >= 30:
                self.error = "WMINING bölümü bulunamadı: flash bellek düzgün yazılmamış ya da bozuk olabilir."
                self.view["connection"] = "WMINING bölümü bekleniyor"
                self.view["error"] = self.error
                display.show(self.view)
                if waited % 60 == 0:
                    log.error(self.error)
            time.sleep(1)
            waited += 1
            self.alive_at = time.monotonic()  # bilerek bekliyoruz: bekçi saymasın
        if waited:
            log.info("WMINING bölümü %d sn sonra hazır", waited)
            self.error = None
        self.conf = config.read_conf()
        self.server = (self.conf.get("SERVER_URL") or config.DEFAULT_SERVER_URL).rstrip("/")
        try:
            self.api = Api(self.server)
        except ValueError as e:  # elle bozulmuş SERVER_URL agent'ı sürekli çökertmesin
            log.error("rig.conf SERVER_URL geçersiz (%s), varsayılan panel kullanılıyor", e)
            self.server = config.DEFAULT_SERVER_URL
            self.api = Api(self.server)
        self.view["server"] = self.server

    def hang_guard(self):
        """Ana döngü uzun süre ilerlemezse (çekirdekte takılan bir komut gibi) süreci bitir; systemd yeniden başlatır."""
        while True:
            time.sleep(30)
            stuck = time.monotonic() - self.alive_at
            if stuck > HANG_LIMIT_SEC:
                log.error("Ana döngü %d sn'dir ilerlemiyor; agent yeniden başlatılıyor", stuck)
                os._exit(3)

    def run(self):
        threading.Thread(target=self.hang_guard, name="hang-guard", daemon=True).start()
        if not self.fake:
            console.provision()  # wm / miner / sreboot komutları ve tty2 konsolu (eski imajlara da gelsin)
        self.wait_conf_partition()
        backoff = 5
        while True:
            try:
                if not self.api.rig_id:
                    self.identity()
                self.tick()
                self.alive_at = time.monotonic()
                backoff = 5
            except ApiError as e:
                if e.status == 401:
                    self.on_unauthorized()
                    continue
                log.warning("Panel hatası: %s", e)
                self.view["connection"] = f"hata ({e.status})"
                display.show(self.view)
                time.sleep(backoff)
                self.alive_at = time.monotonic()
                backoff = min(60, backoff * 2)
            except OSError as e:  # ağ yok, DNS hatası, zaman aşımı
                log.warning("Bağlantı yok: %s", e)
                self.view["connection"] = "bağlantı yok, tekrar deneniyor"
                display.show(self.view)
                for _ in range(backoff):
                    self.watchdog()  # internet gitse de madencilik sürsün
                    time.sleep(1)
                self.alive_at = time.monotonic()
                backoff = min(60, backoff * 2)


def setup_logging():
    os.makedirs(config.RUN_DIR, exist_ok=True)
    handlers = [logging.StreamHandler()]
    try:
        handlers.append(logging.FileHandler(os.path.join(config.RUN_DIR, "agent.log"), encoding="utf-8"))
    except OSError:
        pass
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)
