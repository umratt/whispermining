import time
"""Birim testleri: python -m unittest discover -s tests (agent klasöründen)."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from whisperagent import config, oc  # noqa: E402
from whisperagent.miners.specs import SPECS  # noqa: E402
from whisperagent.util import norm_bus, to_float  # noqa: E402

FS = {"algo": "etchash", "wallet": "0xabc", "worker": "Salon-1", "pool_pass": "x",
      "pools": ["stratum+tcp://etc.2miners.com:1010", "stratum+tcp://eu-etc.2miners.com:1010"]}
NV = [{"bus_id": "01:00.0", "vendor": "nvidia"}, {"bus_id": "03:00.0", "vendor": "nvidia"}]
AMD = [{"bus_id": "02:00.0", "vendor": "amd"}, {"bus_id": "0a:00.0", "vendor": "amd"}]


class ConfTest(unittest.TestCase):
    def test_windows_style_conf(self):
        text = "﻿# yorum\r\nRIG_ID=abc\r\nRIG_SECRET = \"s3cr3t\"\r\n\r\nSERVER_URL=https://x/mining\r\n"
        c = config.parse_conf(text)
        self.assertEqual(c, {"RIG_ID": "abc", "RIG_SECRET": "s3cr3t", "SERVER_URL": "https://x/mining"})

    def test_write_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "rig.conf")
            config.write_conf({"RIG_ID": "a", "RIG_SECRET": "b", "SOURCE": "agent"}, p)
            self.assertEqual(config.read_conf(p), {"RIG_ID": "a", "RIG_SECRET": "b", "SOURCE": "agent"})


class UtilTest(unittest.TestCase):
    def test_bus(self):
        self.assertEqual(norm_bus("00000000:01:00.0"), "01:00.0")
        self.assertEqual(norm_bus("0000:0A:00.0"), "0a:00.0")
        self.assertEqual(norm_bus("1:0"), "01:00.0")

    def test_float(self):
        self.assertIsNone(to_float("[N/A]"))
        self.assertEqual(to_float(" 85.20 "), 85.2)


class MinerArgsTest(unittest.TestCase):
    def test_trex(self):
        a = SPECS["trex"].args(FS, {"extra_args": "--intensity 22"}, NV)
        self.assertEqual(a[:2], ["-a", "etchash"])
        self.assertEqual(a.count("-o"), 2)  # yedek havuz
        self.assertIn("0xabc.Salon-1", a)
        self.assertIn("--pci-indexing", a)
        self.assertEqual(a[-2:], ["--intensity", "22"])

    def test_lolminer_mixed_rig_only_amd(self):
        a = SPECS["lolminer"].args(FS, {}, AMD)
        self.assertIn("etc.2miners.com:1010;eu-etc.2miners.com:1010", a)
        self.assertEqual(a[a.index("--devices") + 1], "AMD")
        self.assertEqual(a[a.index("--algo") + 1], "ETCHASH")

    def test_trm(self):
        a = SPECS["teamredminer"].args(FS, {}, AMD)
        self.assertIn("--bus_reorder", a)
        self.assertIn("--api_listen=127.0.0.1:4028", a)


class AmdOdTest(unittest.TestCase):
    POLARIS = "OD_SCLK:\n0: 300MHz 750mV\n1: 600MHz 769mV\n2: 900MHz 887mV\n3: 1145MHz 1100mV\n4: 1215MHz 1131mV\n5: 1257MHz 1150mV\n6: 1300MHz 1150mV\n7: 1366MHz 1150mV\nOD_MCLK:\n0: 300MHz 750mV\n1: 1000MHz 800mV\n2: 2000MHz 900mV\nOD_RANGE:\nSCLK: 300MHz 2000MHz\n"
    NAVI = "OD_SCLK:\n0: 800Mhz\n1: 2100Mhz\nOD_MCLK:\n1: 875MHz\nOD_VDDC_CURVE:\n0: 800MHz 711mV\n"

    def test_polaris(self):
        self.assertEqual(oc._od_states(self.POLARIS, "OD_SCLK:"), list(range(8)))
        self.assertEqual(oc._od_states(self.POLARIS, "OD_MCLK:"), [0, 1, 2])

    def test_navi(self):
        self.assertEqual(oc._od_states(self.NAVI, "OD_SCLK:"), [0, 1])
        self.assertEqual(oc._od_states(self.NAVI, "OD_MCLK:"), [1])

    def test_apply_amd_writes_polaris_commands(self):
        with tempfile.TemporaryDirectory() as dev:
            os.makedirs(os.path.join(dev, "hwmon", "hwmon0"))
            writes = []
            orig = oc.write_file
            oc.write_file = lambda p, v: writes.append((os.path.basename(p), v))
            with open(os.path.join(dev, "pp_od_clk_voltage"), "w") as f:
                f.write(self.POLARIS)
            with open(os.path.join(dev, "hwmon", "hwmon0", "pwm1_max"), "w") as f:
                f.write("255")
            try:
                msg = oc.apply_amd({"sysfs": dev}, {"core_clock": 1150, "core_mv": 870, "mem_clock": 2100, "mem_mv": 900, "fan_pct": 60})
            finally:
                oc.write_file = orig
            self.assertIn(("pp_od_clk_voltage", "s 7 1150 870"), writes)
            self.assertIn(("pp_od_clk_voltage", "m 2 2100 900"), writes)
            self.assertIn(("pp_od_clk_voltage", "c"), writes)
            self.assertIn(("pwm1", "153"), writes)
            self.assertIn("core 1150MHz", msg)



class ClockJumpTest(unittest.TestCase):
    """Açılışta sistem saati 3 saat geri düzeltilince agent susmamalı (Dükkan rig'inde yaşandı)."""

    def test_wait_poll_ignores_wall_clock_jump(self):
        from unittest import mock
        from whisperagent import agent as agent_mod
        clock = {"wall": 2_000_000_000.0, "mono": 100.0, "sleeps": 0}

        def sleep(sec):
            clock["sleeps"] += 1
            clock["mono"] += sec
            clock["wall"] += sec - 3 * 3600  # her saniye saat 3 saat geri atlıyormuş gibi

        fake = mock.Mock(time=lambda: clock["wall"], monotonic=lambda: clock["mono"], sleep=sleep)
        a = object.__new__(agent_mod.Agent)
        a.poll = 10
        a.watchdog = a.local_commands = a.refresh_screen = lambda: None
        with mock.patch.object(agent_mod, "time", fake):
            a.wait_poll()
        self.assertEqual(clock["sleeps"], 10)


class ConsoleTest(unittest.TestCase):
    """Rig başındaki canlı ekran ve wm / miner komutları."""

    def test_render_live_screen(self):
        from whisperagent import display
        st = {"rig_name": "Dükkan", "connection": "bağlı", "miner": "çalışıyor", "uptime": 3725,
              "flight": {"coin": "RVN", "algo": "kawpow", "pool": "stratum+tcp://rvn.2miners.com:6060", "miners": ["BzMiner"]},
              "gpus": [{"index": 0, "model": "NVIDIA GeForce RTX 3080", "hashrate": 40.25e6, "temp": 62, "fan": 70,
                        "power": 285, "accepted": 33, "rejected": 1}]}
        text = display.render(st)
        self.assertIn("40.25 MH/s", text)
        self.assertIn("33 kabul", text)
        self.assertIn("1 sa 2 dk", text)
        self.assertNotIn("", text)               # status.txt düz yazı
        self.assertIn("[32m", display.render(st, color=True))

    def test_cli_command_reaches_agent(self):
        import tempfile, threading
        from unittest import mock
        from whisperagent import agent as agent_mod, cli, config as cfg
        with tempfile.TemporaryDirectory() as d, mock.patch.object(cfg, "RUN_DIR", d),                 mock.patch.object(cli, "CMD_DIR", os.path.join(d, "cmd")):
            a = object.__new__(agent_mod.Agent)
            a.exec_basic = lambda t: ("done", 0, f"{t} tamam")
            stop = threading.Event()

            def loop():
                while not stop.is_set():
                    a.local_commands()
                    time.sleep(0.05)
            th = threading.Thread(target=loop, daemon=True)
            th.start()
            try:
                with mock.patch("sys.stdout"):
                    self.assertEqual(cli.main(["miner", "restart"]), 0)
            finally:
                stop.set()
                th.join()
            self.assertEqual(os.listdir(os.path.join(d, "cmd")), [])   # komut ve sonuç dosyası temizlendi

if __name__ == "__main__":
    unittest.main()


class NewMinersTest(unittest.TestCase):
    MIXED = [{"bus_id": "03:00.0", "vendor": "nvidia"}, {"bus_id": "0a:00.0", "vendor": "amd"}, {"bus_id": "10:00.0", "vendor": "nvidia"}]

    def stats_with(self, api_type, payloads):
        from whisperagent.miners import specs
        orig = specs._http_json
        specs._http_json = lambda port, path="/", timeout=4: payloads[path] if path in payloads else (_ for _ in ()).throw(OSError("404"))
        try:
            return specs.SPECS[api_type].stats(self.MIXED)
        finally:
            specs._http_json = orig

    def test_gminer(self):
        a = SPECS["gminer"].args(FS, {}, NV)
        self.assertEqual(a[a.index("--server") + 1], "etc.2miners.com")
        self.assertEqual(a[a.index("--port") + 1], "1010")
        self.assertEqual(a[a.index("--opencl") + 1], "0")  # sadece NVIDIA kartlar verildi
        s = self.stats_with("gminer", {"/stat": {"devices": [{"bus_id": "0000:03:00.0", "speed": 21e6, "accepted_shares": 4, "rejected_shares": 1},
                                                              {"bus_id": "0000:10:00.0", "speed": 22e6, "accepted_shares": 2, "rejected_shares": 0}]}})
        self.assertEqual(s["03:00.0"], {"hashrate": 21e6, "accepted": 4, "rejected": 1})
        self.assertIn("10:00.0", s)  # bus 0x10 = 16

    def test_srbminer_mixed_rig_amd_only(self):
        a = SPECS["srbminer"].args(FS, {}, AMD)
        self.assertIn("--disable-gpu-nvidia", a)
        self.assertNotIn("--disable-gpu-amd", a)
        self.assertIn("etc.2miners.com:1010!eu-etc.2miners.com:1010", a)
        s = self.stats_with("srbminer", {"/": {"gpu_devices": [{"device_id": 0, "bus_id": 10}],
                                               "algorithms": [{"hashrate": {"gpu": {"gpu0": 30.5e6, "total": 30.5e6}}}]}})
        self.assertEqual(s["0a:00.0"]["hashrate"], 30.5e6)  # SRB onluk bus 10 = 0x0a

    def test_rigel_generic(self):
        a = SPECS["rigel"].args(FS, {}, NV)
        self.assertEqual(a[a.index("-w") + 1], "Salon-1")
        s = self.stats_with("rigel", {"/": {"devices": [{"pci_id": "03:00.0", "hashrate": {"etchash": 20e6},
                                                         "shares": {"etchash": {"accepted": 7, "rejected": 0}}}]}})
        self.assertEqual(s["03:00.0"], {"hashrate": 20e6, "accepted": 7.0, "rejected": 0.0})

    def test_bzminer_hive_format(self):
        a = SPECS["bzminer"].args(FS, {}, NV)
        self.assertEqual(a[a.index("--amd") + 1], "0")
        s = self.stats_with("bzminer", {"/hive_status": {"hs": [21000.0, 30000.0], "hs_units": "khs", "bus_numbers": [3, 10]}})
        self.assertEqual(s["03:00.0"]["hashrate"], 21e6)
        self.assertEqual(s["0a:00.0"]["hashrate"], 30e6)

    def test_bzminer_hive_shares(self):
        # Kart başına kabul bilgisi varsa kartlara, yoksa toplam ilk karta yazılır (Dükkan rig'inde 0 görünüyordu)
        s = self.stats_with("bzminer", {"/hive_status": {"hs": [21000.0, 30000.0], "hs_units": "khs", "bus_numbers": [3, 10],
                                                         "ar": [12, 1, 0, "5;7"]}})
        self.assertEqual((s["03:00.0"]["accepted"], s["0a:00.0"]["accepted"]), (5, 7))
        s = self.stats_with("bzminer", {"/hive_status": {"hs": [40000.0], "hs_units": "khs", "bus_numbers": [10], "ar": [33, 2]}})
        self.assertEqual((s["0a:00.0"]["accepted"], s["0a:00.0"]["rejected"]), (33, 2))


class TunerTest(unittest.TestCase):
    """Kart başına otomatik OC: sahte kartlarla, simüle edilmiş zamanda uçtan uca."""

    BOUNDS = {"nvidia": {"core_offset": [-1000, 1000], "mem_offset": [-2000, 3000], "power_limit_w": [50, 450], "fan_pct": [0, 100]},
              "amd": {"core_clock": [300, 2000], "mem_clock": [300, 2500], "core_mv": [700, 1200], "mem_mv": [700, 1100], "fan_pct": [0, 100]}}

    def run_tuner(self, preset, model, vendor, start_by_bus=None, global_crash=False):
        """global_crash=True: bir kart sınırı aşınca TÜM miner çöker (hangi kart olduğu belli olmaz)."""
        from whisperagent.hw.fake import FakeHardware
        from whisperagent.tuner import Tuner
        hw = FakeHardware(preset)
        gpus = hw.scan()
        hw.mining = {g["bus_id"] for g in gpus}
        t = 1000.0
        payload = {"model": model, "vendor": vendor, "algo": "etchash", "temp_limit": 85, "bounds": self.BOUNDS[vendor],
                   "per_card": True, "start_by_bus": start_by_bus or {}}
        tu = Tuner(1, payload, gpus, step_sec=60, t=t)

        def apply():
            for b, p in tu.wanted_params_by_bus().items():
                hw.oc[b] = p
        apply()
        restarts = 0
        for _ in range(5000):
            t += 10
            sens = hw.sensors()
            rows = [{"bus_id": g["bus_id"], **sens[g["bus_id"]], "hashrate": hw.fake_hash(g["bus_id"], 1), "rejected": 0} for g in gpus]
            crashed = any(r["hashrate"] <= 0 for r in rows)
            if global_crash and crashed:
                restarts += 1
                rows = [dict(r, hashrate=0) for r in rows]
            tu.feed(rows, not (global_crash and crashed), restarts, t=t)
            act = tu.advance(t)
            if act == "apply":
                apply()
            elif act == "finish":
                break
        self.assertTrue(tu.finished)
        return hw, tu

    def assert_card_limits(self, hw, tu, vendor):
        r = tu.result()
        self.assertEqual(len(r["cards"]), len(tu.targets))
        for c in r["cards"]:
            cur = hw.curve[c["bus_id"]]
            p = c["params"]
            if vendor == "nvidia":
                self.assertLessEqual(p["mem_offset"], cur["mem_sweet"] + 150, c)   # kartı çökertmeyen değer
                self.assertGreaterEqual(p["mem_offset"], cur["mem_sweet"] - 200, c)  # kendi tatlı noktasına yakın
            else:
                self.assertLessEqual(p["mem_clock"], cur["mclk_sweet"] + 25, c)
                self.assertGreaterEqual(p["core_mv"], cur["mv_min"], c)
            hw.oc[c["bus_id"]] = p
            self.assertGreater(hw.fake_hash(c["bus_id"], 1), 0, c)              # önerilen değerle kart çalışıyor
        return r

    def test_p106_each_card_gets_its_own_values(self):
        hw, tu = self.run_tuner("p106", "NVIDIA P106-100", "nvidia")
        self.assertIsNone(tu.failed)
        r = self.assert_card_limits(hw, tu, "nvidia")
        mems = {c["params"]["mem_offset"] for c in r["cards"]}
        self.assertGreater(len(mems), 1, "kartlar farklı değer almalı")    # tek ortak değer değil
        self.assertGreater(r["after"]["hash"] / r["after"]["power"], r["before"]["hash"] / r["before"]["power"])

    def test_whole_miner_crash_finds_the_guilty_card(self):
        hw, tu = self.run_tuner("p106", "NVIDIA P106-100", "nvidia", global_crash=True)
        self.assertIsNone(tu.failed)
        r = self.assert_card_limits(hw, tu, "nvidia")
        self.assertGreater(len({c["params"]["mem_offset"] for c in r["cards"]}), 1)

    def test_rx580_per_card(self):
        hw, tu = self.run_tuner("karma", "AMD Radeon RX 580 8GB", "amd")
        self.assertIsNone(tu.failed)
        self.assert_card_limits(hw, tu, "amd")

    def test_unstable_card_profile_falls_back_only_for_that_card(self):
        hw = __import__("whisperagent.hw.fake", fromlist=["FakeHardware"]).FakeHardware("karma")
        buses = [g["bus_id"] for g in hw.scan() if g["vendor"] == "amd"]
        start = {buses[0]: {"core_clock": 1150, "mem_clock": 2100, "core_mv": 800}, buses[1]: {"core_clock": 1150, "mem_clock": 2000, "core_mv": 950}}
        hw2, tu = self.run_tuner("karma", "AMD Radeon RX 580 8GB", "amd", start_by_bus=start)
        self.assertIsNone(tu.failed)
        r = self.assert_card_limits(hw2, tu, "amd")
        by = {c["bus_id"]: c for c in r["cards"]}
        self.assertTrue(by[buses[0]]["start_was_unstable"])
        self.assertFalse(by[buses[1]]["start_was_unstable"])
