"""Kendini güncelleme: /opt/wmining/agent/releases/<sürüm> + current bağlantısı.

Yeni sürüm açılır, 'current' ona çevrilir, agent kapanır ve systemd yeni sürümü başlatır.
Yeni sürüm 3 açılışta da panele ulaşamazsa eski sürüme döner (start.sh içindeki kontrol).
"""
import hashlib
import os
import ssl
import tarfile
import urllib.request

from .config import STATE_DIR
from .util import log

AGENT_ROOT = os.environ.get("WM_AGENT_ROOT", "/opt/wmining/agent")
PENDING = os.path.join(STATE_DIR, "update-pending")


def confirm_healthy():
    """Panele başarıyla bağlanınca çağrılır: bekleyen güncelleme kalıcı olur."""
    if os.path.exists(PENDING):
        os.remove(PENDING)
        log.info("Güncelleme onaylandı")


def install(info):
    version, url, sha = info["version"], info["download_url"], info["sha256"].lower()
    if not url.startswith("https://"):
        raise RuntimeError("güncelleme adresi https değil")
    releases = os.path.join(AGENT_ROOT, "releases")
    target = os.path.join(releases, version)
    os.makedirs(releases, exist_ok=True)
    tmp = os.path.join(releases, f".{version}.tgz")
    h = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=60, context=ssl.create_default_context()) as r, open(tmp, "wb") as f:
        for chunk in iter(lambda: r.read(1 << 16), b""):
            f.write(chunk)
            h.update(chunk)
    if h.hexdigest() != sha:
        os.remove(tmp)
        raise RuntimeError("güncelleme SHA256 uyuşmuyor")
    os.makedirs(target, exist_ok=True)
    root = os.path.realpath(target)
    with tarfile.open(tmp) as t:
        for m in t.getmembers():
            dest = os.path.realpath(os.path.join(target, m.name))
            if not (dest == root or dest.startswith(root + os.sep)) or m.issym() or m.islnk():
                raise RuntimeError(f"güncelleme arşivinde güvensiz dosya: {m.name}")
        t.extractall(target)
    os.remove(tmp)
    current = os.path.join(AGENT_ROOT, "current")
    previous = os.path.realpath(current) if os.path.exists(current) else ""
    link_tmp = current + ".new"
    if os.path.lexists(link_tmp):
        os.remove(link_tmp)
    os.symlink(target, link_tmp)
    os.replace(link_tmp, current)
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(PENDING, "w") as f:
        f.write(f"{version}\n{previous}\n0\n")
    log.info("Agent %s kuruldu, yeniden başlatılıyor", version)
