"""Ana döngü."""
import json
import logging
import os
import socket
import subprocess
import time

from . import VERSION, config, display, oc, updater
from .api import Api, ApiError
from .hw import backend
from .miners import SPECS, MinerError, MinerProcess, download_miner
from .util import log

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
        self.download_retry_at = 0
        self.last_hw_scan = 0
        self.next_update_check = time.time() + 120
        self.view = {"server": self.server}

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
        self.last_hw_scan = time.time()
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
        for m in fs.get("miners", []):
            spec = SPECS.get(m.get("api_type"))
            if not spec:
                self.error = f"Desteklenmeyen miner: {m.get('name')}"
                continue
            vendors = [v for v in spec.vendors if m.get("gpu_vendor") in ("all", v)]
            gpus = [g for g in self.gpus if g["vendor"] in vendors]
            if not gpus:
                continue  # bu rig'de bu miner'ın kartı yok
            self.miner_state = "downloading"
            self.send_stats_safe()
            binary = download_miner(spec, m, MINER_CACHE)
            env = None
            if self.fake:
                env = dict(os.environ, WM_FAKE_BUSES=",".join(g["bus_id"] for g in gpus), WM_FAKE_ALGO=fs["algo"])
            log_path = os.path.join(config.RUN_DIR, f"miner-{spec.api_type}.log")
            built.append((spec, MinerProcess(spec, binary, spec.args(fs, m, gpus), log_path, env), gpus))
        self.miners = built
        self.error = None
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

    # ---------- ayarlar ----------
    def apply_config(self):
        self.cfg = self.api.config()
        self.config_version = self.cfg.get("config_version")
        self.view["rig_name"] = self.cfg.get("rig_name")
        oc_sig = json.dumps(self.cfg.get("overclock"), sort_keys=True)
        if oc_sig != self.oc_signature:
            self.oc_signature = oc_sig
            oc.apply_all(self.gpus, self.cfg.get("overclock"), self.hw if self.fake else None)
        fs_sig = json.dumps(self.cfg.get("flight_sheet"), sort_keys=True)
        if fs_sig != self.fs_signature:
            self.fs_signature = fs_sig
            try:
                self.build_miners()
            except (MinerError, OSError, ValueError) as e:
                self.miner_state = "error"
                self.error = str(e)
                self.download_retry_at = time.time() + 300
                log.error("Miner hazırlanamadı: %s", e)

    # ---------- komutlar ----------
    def run_commands(self):
        for c in self.api.commands():
            ctype, status, code, out = c["type"], "done", 0, ""
            log.info("Komut: %s", ctype)
            try:
                if ctype == "miner_start":
                    if os.path.exists(STOP_FLAG):
                        os.remove(STOP_FLAG)
                    if not self.miners and self.cfg and self.cfg.get("flight_sheet"):
                        self.build_miners()
                    if self.start_miners():
                        out = "Miner başlatıldı"
                    else:
                        status, code, out = "failed", 1, self.error or "Flight sheet atanmamış ya da uygun kart yok"
                elif ctype == "miner_stop":
                    os.makedirs(config.STATE_DIR, exist_ok=True)
                    open(STOP_FLAG, "w").close()
                    for _s, proc, _g in self.miners:
                        proc.stop()
                    if self.fake:
                        self.hw.mining.clear()
                    self.miner_state = "stopped"
                    out = "Miner durduruldu"
                elif ctype == "miner_restart":
                    if os.path.exists(STOP_FLAG):
                        os.remove(STOP_FLAG)
                    self.fs_signature = None
                    self.apply_config()
                    out = "Miner yeniden başlatıldı" if self.miners else (self.error or "Çalıştırılacak miner yok")
                elif ctype == "apply_oc":
                    out = "; ".join(oc.apply_all(self.gpus, (self.cfg or {}).get("overclock"), self.hw if self.fake else None)) or "OC listesi boş"
                elif ctype == "reboot":
                    self.api.command_result(c["id"], "done", 0, "Yeniden başlatılıyor")
                    self.stop_miners()
                    self.miner_state = "stopped"
                    self.fs_signature = None  # yeniden başlatma olmazsa sonraki turda miner'lar tekrar kurulsun
                    if self.fake:
                        log.info("(simülasyon) yeniden başlatma atlandı")
                    else:
                        subprocess.run(["systemctl", "reboot"], check=False)
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
            rows.append({"bus_id": g["bus_id"], **s})
        if not any(p.running() for _s, p, _g in self.miners) and self.miner_state in ("running", "starting"):
            self.miner_state = "stopped"
        uptime = min((p.uptime() for _s, p, _g in self.miners), default=0)
        sysinfo = self.hw.system()
        self.view["gpus"] = [{**g, **r} for g, r in zip(self.gpus, rows)]
        return {"miner": {"status": self.miner_state, "uptime_sec": uptime, "error": self.error},
                "system": {"cpu_load": sysinfo.get("cpu_load"), "ram_used_mb": sysinfo.get("ram_used_mb")},
                "gpus": rows}

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

        if time.time() - self.last_hw_scan > 60:
            self.rescan()
        if self.error and self.miner_state == "error" and time.time() > self.download_retry_at and not self.miners:
            self.fs_signature = None  # indirme hatası: 5 dakikada bir tekrar dene

        res = self.api.stats(self.collect())
        self.view["connection"] = "bağlı"
        if res.get("hardware_required"):
            self.rescan(force=True)
        if res.get("config_version") != self.config_version or self.fs_signature is None:
            self.apply_config()
        if res.get("pending_commands"):
            self.run_commands()
        self.poll = int(res.get("poll_interval_sec") or self.poll)

        if time.time() > self.next_update_check:
            self.next_update_check = time.time() + 6 * 3600
            self.check_update()

        self.view["miner"] = {"running": "çalışıyor", "starting": "başlıyor", "downloading": "indiriliyor",
                              "stopped": "durduruldu", "error": "hata"}.get(self.miner_state, self.miner_state)
        self.view["error"] = self.error
        display.show(self.view)

        # Bekleme sırasında miner'ları izle
        until = time.time() + self.poll
        while time.time() < until:
            self.watchdog()
            time.sleep(1)

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

    def run(self):
        backoff = 5
        while True:
            try:
                if not self.api.rig_id:
                    self.identity()
                self.tick()
                backoff = 5
            except ApiError as e:
                if e.status == 401:
                    self.on_unauthorized()
                    continue
                log.warning("Panel hatası: %s", e)
                self.view["connection"] = f"hata ({e.status})"
                display.show(self.view)
                time.sleep(backoff)
                backoff = min(60, backoff * 2)
            except OSError as e:  # ağ yok, DNS hatası, zaman aşımı
                log.warning("Bağlantı yok: %s", e)
                self.view["connection"] = "bağlantı yok, tekrar deneniyor"
                display.show(self.view)
                for _ in range(backoff):
                    self.watchdog()  # internet gitse de madencilik sürsün
                    time.sleep(1)
                backoff = min(60, backoff * 2)


def setup_logging():
    os.makedirs(config.RUN_DIR, exist_ok=True)
    handlers = [logging.StreamHandler()]
    try:
        handlers.append(logging.FileHandler(os.path.join(config.RUN_DIR, "agent.log"), encoding="utf-8"))
    except OSError:
        pass
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)
