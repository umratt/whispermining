#!/usr/bin/env python3
"""Sahte miner: dosya adına göre T-Rex, lolMiner ya da TeamRedMiner API'sini taklit eder (sadece test).
Kartlar WM_FAKE_BUSES ortam değişkeninden gelir (agent sahte donanım modunda ayarlar)."""
import json
import os
import random
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

kind = os.path.basename(sys.argv[0]).replace(".py", "")
args = sys.argv[1:]
buses = [b for b in os.environ.get("WM_FAKE_BUSES", "01:00.0").split(",") if b]
start = time.time()
print(f"[{kind}] başladı, kartlar: {buses}, argümanlar: {' '.join(args)}", flush=True)


def arg(name, default=None):
    for i, a in enumerate(args):
        if a == name and i + 1 < len(args):
            return args[i + 1]
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
    return default


def rates():
    up = time.time() - start
    acc = int(up / 6)
    return [(b, random.uniform(29e6, 31e6), acc, 0) for b in buses]


def bus_int(b):
    return int(b.split(":")[0], 16)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        rs = rates()
        if kind == "miner":  # GMiner /stat
            body = {"miner": "GMiner 3.44", "devices": [{"gpu_id": i, "bus_id": f"0000:{b}", "speed": h,
                    "accepted_shares": a, "rejected_shares": r} for i, (b, h, a, r) in enumerate(rs)]}
        elif kind == "SRBMiner-MULTI":
            body = {"miner_version": "3.8.0", "gpu_devices": [{"device_id": i, "bus_id": bus_int(b)} for i, (b, *_x) in enumerate(rs)],
                    "algorithms": [{"name": "etchash", "hashrate": {"gpu": {**{f"gpu{i}": h for i, (_b, h, _a, _r) in enumerate(rs)}, "total": 0}},
                                    "shares": {"accepted": sum(a for *_x, a, _r in rs), "rejected": 0}}]}
        elif kind == "rigel":  # belgesiz biçim: iç içe sözlüklerle
            body = {"devices": [{"id": i, "pci_id": b, "hashrate": {"etchash": h}, "shares": {"etchash": {"accepted": a, "rejected": r}}}
                                for i, (b, h, a, r) in enumerate(rs)]}
        elif kind == "bzminer":
            if self.path != "/hive_status":
                self.send_response(404); self.end_headers(); return
            body = {"hs": [h / 1e3 for _b, h, _a, _r in rs], "hs_units": "khs", "bus_numbers": [bus_int(b) for b, *_x in rs], "ar": [0, 0]}
        elif kind == "t-rex":
            body = {"gpus": [{"device_id": i, "pci_bus": int(b.split(":")[0], 16), "hashrate": h,
                              "shares": {"accepted_count": a, "rejected_count": r}} for i, (b, h, a, r) in enumerate(rates())]}
        else:  # lolMiner
            body = {"Workers": [{"Index": i, "PCIE_Address": f"{int(b.split(':')[0], 16)}:0"} for i, (b, *_x) in enumerate(rs)],
                    "Algorithms": [{"Algorithm": "Etchash", "Performance_Factor": 1e6,
                                    "Worker_Performance": [h / 1e6 for _b, h, _a, _r in rs],
                                    "Worker_Accepted": [a for *_x, a, _r in rs], "Worker_Rejected": [r for *_x, r in rs]}]}
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(data)


def trm_server(port):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", port))
    s.listen()
    while True:
        c, _ = s.accept()
        c.recv(1024)
        devs = [{"GPU": i, "MHS 30s": h / 1e6, "Accepted": a, "Rejected": r} for i, (_b, h, a, r) in enumerate(rates())]
        c.sendall(json.dumps({"DEVS": devs}).encode() + b"\x00")
        c.close()


if kind == "t-rex":
    port = int(arg("--api-bind-http", "127.0.0.1:4067").split(":")[1])
    threading.Thread(target=HTTPServer(("127.0.0.1", port), H).serve_forever, daemon=True).start()
elif kind == "lolMiner":
    port = int(arg("--apiport", "4068"))
    threading.Thread(target=HTTPServer(("127.0.0.1", port), H).serve_forever, daemon=True).start()
elif kind in ("miner", "SRBMiner-MULTI", "rigel", "bzminer"):
    port = {"miner": lambda: int(arg("--api", "4069")), "SRBMiner-MULTI": lambda: int(arg("--api-port", "21550")),
            "rigel": lambda: int(arg("--api-bind", "127.0.0.1:4070").split(":")[1]),
            "bzminer": lambda: next((int(a.split("=")[1]) for a in args if a.startswith("http_port=")), 4014)}[kind]()
    threading.Thread(target=HTTPServer(("127.0.0.1", port), H).serve_forever, daemon=True).start()
else:
    port = int(arg("--api_listen", "127.0.0.1:4028").split(":")[1])
    threading.Thread(target=trm_server, args=(port,), daemon=True).start()

while True:
    time.sleep(10)
    print(f"[{kind}] {sum(h for _b, h, _a, _r in rates()) / 1e6:.1f} MH/s", flush=True)
