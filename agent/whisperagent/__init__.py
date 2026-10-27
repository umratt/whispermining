"""WhisperMining rig agent'ı.

Rig'de systemd servisi olarak çalışır: rig.conf'u okur, panele bağlanır, kartları tarar,
istatistik gönderir, flight sheet'teki miner'ı indirip çalıştırır, OC uygular ve komutları yürütür.
Sadece Python standart kütüphanesini kullanır (Ubuntu 22.04: Python 3.10).
"""

VERSION = "1.1.3"
