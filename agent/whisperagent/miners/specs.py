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


SPECS = {s.api_type: s for s in (TRex(), LolMiner(), TeamRedMiner())}


def normalize_bus(bus):
    return norm_bus(bus)
