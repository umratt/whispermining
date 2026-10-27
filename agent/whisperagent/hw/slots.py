"""Kartın takılı olduğu fiziksel yuva: anakartın SMBIOS yuva tablosu (tip 9) ve ACPI yuvaları.

Tablo çoğu anakartta kartın değil, yuvanın bağlı olduğu köprünün adresini verir (ör. J6B1 → 00:1c.3).
Bu yüzden kart sysfs yolundaki köprüleriyle birlikte eşlenir.
"""
import os
import re

from ..util import norm_bus

DMI_PATH = "/sys/firmware/dmi/tables/DMI"
ACPI_PATH = "/sys/bus/pci/slots"
PCI_PATH = "/sys/bus/pci/devices"
USAGE = {3: "Available", 4: "In Use"}
PCI_ADDR = re.compile(r"^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$")


def smbios(path=DMI_PATH):
    """SMBIOS yuva kayıtları: [(ad, adres ya da None, durum)]."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return []
    rows, i = [], 0
    while i + 4 <= len(data):
        typ, ln = data[i], data[i + 1]
        if ln < 4:
            break
        end = data.find(b"\0\0", i + ln)
        if end < 0:
            break
        strings = data[i + ln:end].split(b"\0")
        if typ == 9 and ln >= 17:
            idx = data[i + 4]
            name = strings[idx - 1].decode("ascii", "replace").strip() if 0 < idx <= len(strings) else "?"
            seg, bus, devfn = int.from_bytes(data[i + 13:i + 15], "little"), data[i + 15], data[i + 16]
            addr = f"{seg:04x}:{bus:02x}:{devfn >> 3:02x}.{devfn & 7}" if bus != 0xff else None
            rows.append((name, addr, USAGE.get(data[i + 7], "Unknown")))
        if typ == 127:
            break
        i = end + 2
    return rows


def acpi(base=ACPI_PATH):
    """ACPI yuvaları: [(ad, 'dddd:bb:dd' adresi)]."""
    out = []
    for name in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        try:
            with open(os.path.join(base, name, "address")) as f:
                out.append((name, f.read().strip().lower()))
        except OSError:
            pass
    return out


def chain(bus_id, base=PCI_PATH):
    """Kartın adresi ve üstündeki köprüler, karttan köke doğru."""
    full = bus_id if bus_id.count(":") == 2 else f"0000:{bus_id}"
    path = os.path.realpath(os.path.join(base, full))
    parts = [p for p in path.split(os.sep) if PCI_ADDR.match(p)]
    return list(reversed(parts)) or [full]


def names(bus_ids, dmi=DMI_PATH, acpi_base=ACPI_PATH, pci=PCI_PATH):
    """{kart adresi: yuva adı}; yuvası bilinmeyen kart listede yer almaz."""
    table = {addr: name for name, addr, _u in smbios(dmi) if addr and name}
    acpi_slots = acpi(acpi_base)
    out = {}
    for bus in bus_ids:
        for addr in chain(bus, pci):
            name = table.get(addr) or next((n for n, a in acpi_slots if addr.startswith(a + ".")), None)
            if name:
                out[norm_bus(bus)] = name
                break
    return out
