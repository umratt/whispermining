"""Desteklenen miner'lar: komut satırı ve istatistik API'si.

Her miner kendi kart türünün TÜM kartlarını kullanır (flight sheet'te kart türüne göre en fazla bir miner olur).
İstatistikler PCI adresine (bus_id) göre panele eşlenir.
"""
import json
import os
import shlex
import socket
import urllib.request

from ..util import norm_bus

LOCAL = "127.0.0.1"


def _http_json(port, path="/", timeout=4):
    with urllib.request.urlopen(f"http://{LOCAL}:{port}{path}", timeout=timeout) as r:
        return json.loads(r.read())


def _bus_key(bus_id):
    return int(bus_id.split(":")[0], 16)


class Spec:
    name = api_type = binary = ""
    port = 0
    vendors = ()
    algos = {}

    def find_binary(self, root):
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                if f == self.binary or f == self.binary + ".py":
                    return os.path.join(dirpath, f)
        raise FileNotFoundError(f"{self.binary} arşivde bulunamadı")

    def algo(self, algo):
        return self.algos.get(algo, algo)

    def user(self, fs):
        return f"{fs['wallet']}.{fs['worker']}" if fs.get("worker") else fs["wallet"]

    def extra(self, miner):
        return shlex.split(miner.get("extra_args") or "")


class TRex(Spec):
    name, api_type, binary, port = "T-Rex", "trex", "t-rex", 4067
    vendors = ("nvidia",)
    algos = {"etchash": "etchash", "kawpow": "kawpow", "autolykos2": "autolykos2", "octopus": "octopus", "firopow": "firopow"}

    def args(self, fs, miner, gpus):
        a = ["-a", self.algo(fs["algo"])]
        for pool in fs["pools"]:
            a += ["-o", pool, "-u", self.user(fs), "-p", fs.get("pool_pass") or "x"]
        a += ["--api-bind-http", f"{LOCAL}:{self.port}", "--pci-indexing", "--no-watchdog", "--no-color"]
        return a + self.extra(miner)

    def stats(self, gpus):
        data = _http_json(self.port, "/summary")
        out = {}
        for g in data.get("gpus", []):
            bus = next((x["bus_id"] for x in gpus if _bus_key(x["bus_id"]) == int(g.get("pci_bus", -1))), None)
            if bus:
                sh = g.get("shares") or {}
                out[bus] = {"hashrate": g.get("hashrate"), "accepted": sh.get("accepted_count"), "rejected": sh.get("rejected_count")}
        return out


class LolMiner(Spec):
    name, api_type, binary, port = "lolMiner", "lolminer", "lolMiner", 4068
    vendors = ("nvidia", "amd")
    algos = {"etchash": "ETCHASH", "autolykos2": "AUTOLYKOS2", "kaspa": "KASPADUAL", "alephium": "ALEPH",
             "beamhash": "BEAM-III", "equihash125_4": "EQUI125_4"}

    def args(self, fs, miner, gpus):
        hosts, tls = [], False
        for pool in fs["pools"]:
            scheme, _, host = pool.partition("://")
            tls = tls or "ssl" in scheme or "tls" in scheme
            hosts.append(host or pool)
        n = len(hosts)
        a = ["--algo", self.algo(fs["algo"]), "--pool", ";".join(hosts), "--user", ";".join([self.user(fs)] * n),
             "--pass", ";".join([fs.get("pool_pass") or "x"] * n), "--apihost", LOCAL, "--apiport", str(self.port)]
        if tls:
            a += ["--tls", "on"]
        vendors = {g["vendor"] for g in gpus}
        if vendors == {"nvidia"}:
            a += ["--devices", "NVIDIA"]
        elif vendors == {"amd"}:
            a += ["--devices", "AMD"]
        return a + self.extra(miner)

    def stats(self, gpus):
        data = _http_json(self.port, "/")
        workers = data.get("Workers", [])
        algo = (data.get("Algorithms") or [{}])[0]
        factor = float(algo.get("Performance_Factor") or 1e6)
        perf = algo.get("Worker_Performance") or []
        acc = algo.get("Worker_Accepted") or []
        rej = algo.get("Worker_Rejected") or []
        out = {}
        for i, w in enumerate(workers):
            addr = str(w.get("PCIE_Address", ""))  # "1:0" (onluk bus:aygıt)
            try:
                busn, dev = (int(x) for x in addr.split(":"))
                bus = f"{busn:02x}:{dev:02x}.0"
            except ValueError:
                continue
            if any(g["bus_id"] == bus for g in gpus):
                out[bus] = {"hashrate": (perf[i] * factor) if i < len(perf) else None,
                            "accepted": acc[i] if i < len(acc) else None, "rejected": rej[i] if i < len(rej) else None}
        return out


class TeamRedMiner(Spec):
    name, api_type, binary, port = "TeamRedMiner", "teamredminer", "teamredminer", 4028
    vendors = ("amd",)
    algos = {"etchash": "etchash", "kawpow": "kawpow", "autolykos2": "autolykos2", "firopow": "firopow"}

    def args(self, fs, miner, gpus):
        a = ["-a", self.algo(fs["algo"])]
        for pool in fs["pools"]:
            a += ["-o", pool, "-u", self.user(fs), "-p", fs.get("pool_pass") or "x"]
        # --bus_reorder: kart numaraları PCI sırasına göre (istatistik eşlemesi bunu varsayar)
        a += [f"--api_listen={LOCAL}:{self.port}", "--bus_reorder"]
        return a + self.extra(miner)

    def stats(self, gpus):
        with socket.create_connection((LOCAL, self.port), timeout=4) as s:
            s.sendall(b'{"command":"devs"}')
            raw = b""
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                raw += chunk
        data = json.loads(raw.rstrip(b"\x00").decode(errors="replace"))
        amd = sorted((g for g in gpus if g["vendor"] == "amd"), key=lambda g: g["bus_id"])
        out = {}
        for d in data.get("DEVS", []):
            i = int(d.get("GPU", -1))
            if 0 <= i < len(amd):
                mhs = d.get("MHS 30s", d.get("MHS av"))
                out[amd[i]["bus_id"]] = {"hashrate": mhs * 1e6 if mhs is not None else None,
                                         "accepted": d.get("Accepted"), "rejected": d.get("Rejected")}
        return out


def _match_bus(value, gpus):
    """Miner'ın verdiği PCI bilgisini bizim bus_id'mize çevir: 1 (onluk bus no), "01:00.0", "0000:01:00.0", "1:0"."""
    if value is None or value == "":
        return None
    try:
        if isinstance(value, (int, float)):
            busn = int(value)
        else:
            s = str(value).strip()
            if s.isdigit():
                busn = int(s)
            else:
                nb = norm_bus(s)
                return next((g["bus_id"] for g in gpus if g["bus_id"] == nb), None) or \
                    next((g["bus_id"] for g in gpus if _bus_key(g["bus_id"]) == _bus_key(nb)), None)
    except (ValueError, IndexError):
        return None
    return next((g["bus_id"] for g in gpus if _bus_key(g["bus_id"]) == busn), None)


def _num(v):
    """Sayı ya da {algo: sayı} sözlüğü → sayı (ilk algoritma)."""
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, dict):
        for x in v.values():
            n = _num(x)
            if n is not None:
                return n
    if isinstance(v, list) and v:
        return _num(v[0])
    return None


HASH_KEYS = ("hashrate", "hash_rate", "speed", "hr", "hashrate_now", "current_hashrate")
BUS_KEYS = ("pci_bus_id", "pcie_bus_id", "pci_bus", "pcie_bus", "bus_id", "busid", "pci_id", "pci", "bus")
ACC_KEYS = ("accepted", "accepted_shares", "valid_solutions", "valid_shares", "shares_accepted")
REJ_KEYS = ("rejected", "rejected_shares", "rejected_solutions", "shares_rejected", "invalid")


def _pick(d, keys):
    low = {str(k).lower(): v for k, v in d.items()}
    for k in keys:
        if k in low:
            return low[k]
    for k, v in low.items():  # iç içe: {"shares": {"accepted": 5}}
        if isinstance(v, dict):
            r = _pick(v, keys)
            if r is not None:
                return r
    return None


def generic_devices(data, gpus):
    """Belgesi eksik miner'lar için: JSON içinde PCI + hashrate alanı olan cihaz listesini bulur.
    HiveOS biçimini de (hs, hs_units, bus_numbers, ar) tanır."""
    out = {}
    if isinstance(data, dict) and isinstance(data.get("hs"), list) and isinstance(data.get("bus_numbers"), list):
        mult = {"hs": 1, "khs": 1e3, "mhs": 1e6, "ghs": 1e9}.get(str(data.get("hs_units", "khs")).lower(), 1e3)
        # ar: [kabul, red, (geçersiz), ("k1;k2;..." kart başına kabul)]
        ar = data.get("ar") if isinstance(data.get("ar"), list) else []
        per_gpu = str(ar[3]).split(";") if len(ar) > 3 and isinstance(ar[3], str) else None
        for i, h in enumerate(data["hs"]):
            bus = _match_bus(data["bus_numbers"][i] if i < len(data["bus_numbers"]) else None, gpus)
            if bus and _num(h) is not None:
                out[bus] = {"hashrate": _num(h) * mult, "accepted": None, "rejected": None}
                if per_gpu and i < len(per_gpu):
                    try:
                        out[bus]["accepted"] = float(per_gpu[i])
                    except ValueError:
                        pass
        # Kart başına bilgi yoksa toplam ilk karta yazılır (rig toplamı doğru kalsın)
        if out and ar and not per_gpu:
            first = next(iter(out.values()))
            first["accepted"], first["rejected"] = _num(ar[0]), _num(ar[1]) if len(ar) > 1 else None
        return out

    def walk(node):
        if isinstance(node, list) and node and all(isinstance(x, dict) for x in node):
            found = {}
            for d in node:
                bus = _match_bus(_pick(d, BUS_KEYS), gpus)
                h = _num(_pick(d, HASH_KEYS))
                if bus and h is not None:
                    found[bus] = {"hashrate": h, "accepted": _num(_pick(d, ACC_KEYS)), "rejected": _num(_pick(d, REJ_KEYS))}
            if found:
                return found
        if isinstance(node, dict):
            for v in node.values():
                r = walk(v)
                if r:
                    return r
        if isinstance(node, list):
            for v in node:
                r = walk(v)
                if r:
                    return r
        return None
    return walk(data) or out


class GMiner(Spec):
    name, api_type, binary, port = "GMiner", "gminer", "miner", 4069
    vendors = ("nvidia", "amd")
    algos = {"etchash": "etchash", "kawpow": "kawpow", "autolykos2": "autolykos2", "octopus": "octopus",
             "firopow": "firopow", "beamhash": "beamhashIII", "equihash125_4": "equihash125_4"}

    def args(self, fs, miner, gpus):
        a = ["--algo", self.algo(fs["algo"])]
        for pool in fs["pools"]:
            scheme, _, hostport = pool.partition("://")
            host, _, port = (hostport or pool).rpartition(":")
            a += ["--server", host, "--port", port, "--user", self.user(fs), "--pass", fs.get("pool_pass") or "x"]
            if "ssl" in scheme or "tls" in scheme:
                a += ["--ssl", "1"]
        vendors = {g["vendor"] for g in gpus}
        a += ["--cuda", "1" if "nvidia" in vendors else "0", "--opencl", "1" if "amd" in vendors else "0"]
        a += ["--api", str(self.port), "--pec", "0", "--watchdog", "0"]
        return a + self.extra(miner)

    def stats(self, gpus):
        data = _http_json(self.port, "/stat")
        out = {}
        for d in data.get("devices", []):
            bus = _match_bus(d.get("bus_id"), gpus)
            if bus:
                out[bus] = {"hashrate": d.get("speed"), "accepted": d.get("accepted_shares"), "rejected": d.get("rejected_shares")}
        return out


class SRBMiner(Spec):
    name, api_type, binary, port = "SRBMiner-Multi", "srbminer", "SRBMiner-MULTI", 21550
    vendors = ("nvidia", "amd")
    algos = {"etchash": "etchash", "kawpow": "kawpow", "autolykos2": "autolykos2", "firopow": "firopow",
             "alephium": "blake3_alephium", "kaspa": "kheavyhash", "pearl": "pearlhash", "quantus": "quantus",
             "evrprogpow": "evrprogpow"}

    def args(self, fs, miner, gpus):
        pools = []
        for pool in fs["pools"]:
            scheme, _, hostport = pool.partition("://")
            pools.append(("stratum+ssl://" if ("ssl" in scheme or "tls" in scheme) else "") + (hostport or pool))
        a = ["--algorithm", self.algo(fs["algo"]), "--pool", "!".join(pools), "--wallet", self.user(fs),
             "--password", fs.get("pool_pass") or "x", "--disable-cpu", "--api-enable", "--api-port", str(self.port)]
        vendors = {g["vendor"] for g in gpus}
        if "amd" not in vendors:
            a.append("--disable-gpu-amd")
        if "nvidia" not in vendors:
            a.append("--disable-gpu-nvidia")
        return a + self.extra(miner)

    def stats(self, gpus):
        data = _http_json(self.port, "/")
        algo = (data.get("algorithms") or [{}])[0]
        per_gpu = (algo.get("hashrate") or {}).get("gpu") or {}
        out = {}
        for dev in data.get("gpu_devices", []):
            bus = _match_bus(dev.get("bus_id"), gpus)
            h = per_gpu.get(f"gpu{dev.get('device_id')}")
            if bus and h is not None:
                out[bus] = {"hashrate": h, "accepted": None, "rejected": None}  # SRB share'leri sadece toplam verir
        return out


class Rigel(Spec):
    name, api_type, binary, port = "Rigel", "rigel", "rigel", 4070
    vendors = ("nvidia",)
    algos = {"etchash": "etchash", "kawpow": "kawpow", "autolykos2": "autolykos2", "octopus": "octopus", "alephium": "alephium"}

    def args(self, fs, miner, gpus):
        a = ["-a", self.algo(fs["algo"])]
        for pool in fs["pools"]:
            a += ["-o", pool]
        a += ["-u", fs["wallet"], "-w", fs.get("worker") or "rig", "-p", fs.get("pool_pass") or "x",
              "--api-bind", f"{LOCAL}:{self.port}"]
        return a + self.extra(miner)

    def stats(self, gpus):
        return generic_devices(_http_json(self.port, "/"), gpus)  # alan adları resmî olarak belgelenmemiş


class BzMiner(Spec):
    name, api_type, binary, port = "BzMiner", "bzminer", "bzminer", 4014
    vendors = ("nvidia", "amd")
    algos = {"etchash": "etchash", "kawpow": "kawpow", "autolykos2": "ergo", "alephium": "alph", "octopus": "olhash", "pearl": "pearl", "quantus": "quantus"}

    def args(self, fs, miner, gpus):
        a = ["-a", self.algo(fs["algo"])]
        for pool in fs["pools"]:
            a += ["-p", pool]
        a += ["-w", fs["wallet"], "--pass", fs.get("pool_pass") or "x",
              "--set", f"http_address={LOCAL}", "--set", f"http_port={self.port}"]
        if fs.get("worker"):
            a += ["--worker", fs["worker"]]
        vendors = {g["vendor"] for g in gpus}
        if "amd" not in vendors:
            a += ["--amd", "0"]
        if "nvidia" not in vendors:
            a += ["--nvidia", "0"]
        return a + self.extra(miner)

    api_paths = ("/hive_status", "/status", "/api/snapshot")

    def stats(self, gpus):
        # Hashrate için ilk cevap veren yol; share sayıları bazı sürümlerde sadece /status'ta (valid_solutions) dolu
        found = []
        for path in self.api_paths:
            try:
                r = generic_devices(_http_json(self.port, path), gpus)
            except Exception:
                continue
            if r:
                found.append(r)
        if not found:
            return {}
        base = found[0]
        for other in found[1:]:
            for bus, v in base.items():
                o = other.get(bus) or {}
                if not v.get("accepted") and o.get("accepted"):
                    v["accepted"], v["rejected"] = o["accepted"], o.get("rejected")
        return base


SPECS = {s.api_type: s for s in (TRex(), LolMiner(), TeamRedMiner(), GMiner(), SRBMiner(), Rigel(), BzMiner())}


def normalize_bus(bus):
    return norm_bus(bus)
