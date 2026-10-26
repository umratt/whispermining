"""Miner indirme (SHA256 doğrulamalı), açma ve süreç yönetimi."""
import hashlib
import os
import shutil
import ssl
import stat
import subprocess
import sys
import tarfile
import time
import urllib.parse
import urllib.request
import zipfile

from ..util import log


class MinerError(Exception):
    pass


def _safe_members(tar, dest):
    """Arşivden dışarı yazmaya çalışan (../) dosyaları reddet."""
    root = os.path.realpath(dest)
    for m in tar.getmembers():
        target = os.path.realpath(os.path.join(dest, m.name))
        if not (target == root or target.startswith(root + os.sep)):
            raise MinerError(f"arşivde güvensiz yol: {m.name}")
        if m.issym() or m.islnk():
            link = os.path.realpath(os.path.join(os.path.dirname(target), m.linkname))
            if not link.startswith(root + os.sep):
                raise MinerError(f"arşivde güvensiz bağlantı: {m.name}")
        yield m


def download_miner(spec, miner, cache_dir, on_progress=None):
    """Miner'ı indir, doğrula, aç. Çalıştırılabilir dosyanın yolunu döndürür.
    Aynı sürüm daha önce indirildiyse tekrar indirmez."""
    url, sha = miner.get("download_url") or "", (miner.get("sha256") or "").lower()
    if not sha:
        raise MinerError(f"{miner['name']} {miner['version']}: katalogda SHA256 yok, güvenlik için indirilmedi")
    parsed = urllib.parse.urlparse(url)
    dev_http = os.environ.get("WM_INSECURE_DEV") == "1" and parsed.hostname in ("localhost", "127.0.0.1")
    if parsed.scheme != "https" and not dev_http:
        raise MinerError("indirme adresi https değil")

    dest = os.path.join(cache_dir, spec.api_type, miner["version"])
    marker = os.path.join(dest, ".ok")
    if os.path.exists(marker) and open(marker).read().strip() == sha:
        try:
            return spec.find_binary(dest)
        except FileNotFoundError:
            # İşaret var ama program yok (flash bozulması, silinme): baştan indir
            log.warning("%s önbellekte eksik, yeniden indiriliyor", spec.name)
            os.remove(marker)

    os.makedirs(cache_dir, exist_ok=True)
    tmp = os.path.join(cache_dir, f".{spec.api_type}-{miner['version']}.download")
    h = hashlib.sha256()
    ctx = ssl.create_default_context() if parsed.scheme == "https" else None
    req = urllib.request.Request(url, headers={"user-agent": "whisperagent"})
    log.info("Miner indiriliyor: %s", url)
    with urllib.request.urlopen(req, timeout=60, context=ctx) as res, open(tmp, "wb") as out:
        total = int(res.headers.get("content-length") or 0)
        done = 0
        while True:
            chunk = res.read(1 << 16)
            if not chunk:
                break
            out.write(chunk)
            h.update(chunk)
            done += len(chunk)
            if on_progress and total:
                on_progress(done * 100 // total)
    if h.hexdigest() != sha:
        os.remove(tmp)
        raise MinerError(f"SHA256 uyuşmuyor: beklenen {sha[:12]}…, gelen {h.hexdigest()[:12]}… (dosya bozuk ya da değiştirilmiş)")

    if os.path.isdir(dest):
        shutil.rmtree(dest)
    os.makedirs(dest)
    name = parsed.path.lower()
    try:
        if name.endswith(".zip"):
            with zipfile.ZipFile(tmp) as z:
                for n in z.namelist():
                    target = os.path.realpath(os.path.join(dest, n))
                    if not target.startswith(os.path.realpath(dest) + os.sep):
                        raise MinerError(f"arşivde güvensiz yol: {n}")
                z.extractall(dest)
        else:
            with tarfile.open(tmp) as t:
                t.extractall(dest, members=_safe_members(t, dest))
    finally:
        os.remove(tmp)
    binary = spec.find_binary(dest)
    os.chmod(binary, os.stat(binary).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    with open(marker, "w") as f:
        f.write(sha)
    return binary


class MinerProcess:
    """Bir miner sürecini çalıştırır, çökerse artan beklemeyle yeniden başlatır."""

    def __init__(self, spec, binary, args, log_path, env=None):
        self.spec, self.binary, self.args, self.log_path = spec, binary, args, log_path
        self.env = env
        self.proc = None
        self.started_at = None
        self.restarts = 0
        self.next_restart = 0
        self.last_exit = None

    def _cmd(self):
        # Geliştirme (Windows): sahte miner Python betiğidir
        if os.name == "nt" or self.binary.endswith(".py"):
            with open(self.binary, "rb") as f:
                if f.read(2) == b"#!":
                    return [sys.executable, self.binary] + self.args
        return [self.binary] + self.args

    def start(self):
        os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
        logf = open(self.log_path, "ab", buffering=0)
        log.info("Miner başlatılıyor: %s %s", self.spec.name, " ".join(self.args))
        self.proc = subprocess.Popen(self._cmd(), stdout=logf, stderr=subprocess.STDOUT, cwd=os.path.dirname(self.binary),
                                     env=self.env, start_new_session=(os.name != "nt"))
        logf.close()
        self.started_at = time.time()

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def stop(self, timeout=15):
        if not self.proc:
            return
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(5)
        self.proc = None
        self.started_at = None

    def watchdog(self):
        """Çöktüyse yeniden başlat (5 sn, 10, 20 … en fazla 120 sn bekleyerek). Durum metni döner."""
        if self.running():
            if self.started_at and time.time() - self.started_at > 600:
                self.restarts = 0  # 10 dk sorunsuz çalıştı
            return "running"
        if self.proc is not None:
            self.last_exit = self.proc.returncode
            log.warning("%s kapandı (kod %s)", self.spec.name, self.last_exit)
            self.proc = None
            self.started_at = None
            self.next_restart = time.time() + min(120, 5 * (2 ** self.restarts))
            self.restarts += 1
        if time.time() >= self.next_restart:
            self.start()
            return "starting"
        return "error"

    def uptime(self):
        return int(time.time() - self.started_at) if self.started_at else 0

    def tail(self, n=20):
        try:
            with open(self.log_path, "rb") as f:
                f.seek(0, 2)
                f.seek(max(0, f.tell() - 4000))
                return f.read().decode(errors="replace").splitlines()[-n:]
        except OSError:
            return []
