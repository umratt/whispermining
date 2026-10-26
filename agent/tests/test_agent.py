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


class TunerTest(unittest.TestCase):
    """Otomatik OC'yi sahte kartlarla, simüle edilmiş zamanda uçtan uca çalıştırır."""

    def run_tuner(self, preset, model, vendor, start=None):
        from whisperagent.hw.fake import FakeHardware
        from whisperagent.tuner import Tuner
        from whisperagent.miners import specs  # noqa: F401
        hw = FakeHardware(preset)
        gpus = hw.scan()
        hw.mining = {g["bus_id"] for g in gpus}
        bounds = {"nvidia": {"core_offset": [-1000, 1000], "mem_offset": [-2000, 3000], "power_limit_w": [50, 450], "fan_pct": [0, 100]},
                  "amd": {"core_clock": [300, 2000], "mem_clock": [300, 2500], "core_mv": [700, 1200], "mem_mv": [700, 1100], "fan_pct": [0, 100]}}[vendor]
        t = 1000.0
        tu = Tuner(1, {"model": model, "vendor": vendor, "algo": "etchash", "temp_limit": 85, "bounds": bounds, "start": start}, gpus, step_sec=60, t=t)

        def apply():
            for b in tu.targets:
                hw.oc[b] = tu.wanted_params()
        apply()
        for _ in range(2000):
            t += 10
            sens = hw.sensors()
            rows = [{"bus_id": g["bus_id"], **sens[g["bus_id"]], "hashrate": hw.fake_hash(g["bus_id"], 1), "rejected": 0} for g in gpus]
            tu.feed(rows, True, 0, t=t)
            act = tu.advance(t)
            if act == "apply":
                apply()
            elif act == "finish":
                break
        self.assertTrue(tu.finished)
        return hw, tu

    def test_p106_finds_stable_memory_and_lower_power(self):
        hw, tu = self.run_tuner("karma", "NVIDIA P106-100", "nvidia")
        self.assertIsNone(tu.failed, tu.history)
        p = tu.result()["params"]
        sweets = [hw.curve[b]["mem_sweet"] for b in tu.targets]
        self.assertLessEqual(p["mem_offset"], min(sweets) + 150)        # hiçbir kartı çökertmeyen değer
        self.assertGreaterEqual(p["mem_offset"], min(sweets) - 300)     # ama tatlı noktaya yakın
        self.assertIn("power_limit_w", p)
        self.assertLess(p["power_limit_w"], 82)                          # stok güçten düşük
        r = tu.result()
        self.assertGreater(r["after"]["hash"] / r["after"]["power"], r["before"]["hash"] / r["before"]["power"])  # verim arttı
        for b in tu.targets:                                             # önerilen değerle tüm kartlar çalışıyor
            hw.oc[b] = p
            self.assertGreater(hw.fake_hash(b, 1), 0)

    def test_rx580_memory_and_voltage(self):
        hw, tu = self.run_tuner("karma", "AMD Radeon RX 580 8GB", "amd")
        self.assertIsNone(tu.failed, tu.history)
        p = tu.result()["params"]
        for b in tu.targets:
            c = hw.curve[b]
            self.assertLessEqual(p["mem_clock"], c["mclk_sweet"] + 25)
            self.assertGreaterEqual(p["core_mv"], c["mv_min"])
        self.assertLess(p["core_mv"], 950)

    def test_unstable_profile_falls_back_to_safe_start(self):
        hw, tu = self.run_tuner("p106", "NVIDIA P106-100", "nvidia", start={"mem_offset": 2500})
        self.assertIsNone(tu.failed, tu.history)
        r = tu.result()
        self.assertTrue(r["start_was_unstable"])
        self.assertLessEqual(r["params"]["mem_offset"], min(hw.curve[b]["mem_sweet"] for b in tu.targets) + 150)

    def test_rx580_with_too_low_voltage_profile(self):
        hw, tu = self.run_tuner("karma", "AMD Radeon RX 580 8GB", "amd", start={"core_clock": 1150, "mem_clock": 2100, "core_mv": 870})
        self.assertIsNone(tu.failed, tu.history)
        self.assertGreaterEqual(tu.result()["params"]["core_mv"], max(hw.curve[b]["mv_min"] for b in tu.targets))
