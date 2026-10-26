"""Kullanım:
  python3 -m whisperagent            agent'ı çalıştır (systemd servisi bunu çağırır)
  python3 -m whisperagent --scan     kartları tara ve ekrana yaz (kurulum kontrolü)
  python3 -m whisperagent --version
"""
import json
import sys

from . import VERSION


def main():
    if "--version" in sys.argv:
        print(VERSION)
        return
    if "--scan" in sys.argv:
        from .hw import backend
        hw = backend()
        print(json.dumps({"gpus": hw.scan(), "sensors": hw.sensors(), "system": hw.system()}, indent=2, ensure_ascii=False))
        return
    from .agent import Agent, setup_logging
    setup_logging()
    Agent().run()


if __name__ == "__main__":
    main()
