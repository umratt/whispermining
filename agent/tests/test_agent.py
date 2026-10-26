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
