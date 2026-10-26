# Agent API (v1)

Rig'de çalışan agent'ın (Aşama 2) sunucuyla konuştuğu API. Panelin kullandığı API'den ayrıdır.

- **Temel adres:** `https://www.whisperkripto.com/mining/api/agent/v1`
- **Biçim:** JSON (`content-type: application/json`), en fazla 64 KB gövde
- **Zaman:** tüm zaman damgaları Unix saniyesi (UTC)
- **Taşıma:** sadece HTTPS. Agent sertifikayı doğrulamalı, `verify=False` kullanılmamalı.

Örnek akışı uçtan uca görmek için `simulator/fake-agent.js` dosyasına bakın. Gerçek agent da aynı sırayla çalışmalı.

---

## Kimlik doğrulama

Kayıt (`/register`) dışındaki tüm istekler bu başlığı taşır:

```
Authorization: Bearer <rig_id>.<rig_secret>
```

- `rig_secret` bir kez verilir (kayıtta ya da panelden indirilen `rig.conf`'ta). Sunucu sadece SHA-256 hash'ini saklar, sonradan tekrar gösterilemez.
- İkisi de flash bellekteki `rig.conf` dosyasında durur.
- `401 invalid_credentials`: rig panelden silinmiş ya da anahtarı yenilenmiş demektir. Kimlik eşleştirme koduyla (B) alındıysa agent kimliği silip yeniden kayıt olur. Panelden indirilen `rig.conf` (A) ile kurulduysa yeniden kayıt olmaz, yeni dosyayı bekler.
- Rig henüz bir hesaba eşleşmediyse `/stats`, `/config`, `/commands` uç noktaları `403 not_paired` döner.

## Rig'i hesaba bağlamanın iki yolu

**A) rig.conf ile (önerilen, ekransız rig'ler için).** Kullanıcı panelde *Rig ekle → rig.conf ile* der. Sunucu rig'i
önceden oluşturur ve hesaba bağlar, gizli anahtarı içeren `rig.conf` bir kez indirilir. Kullanıcı dosyayı flash belleğin
FAT bölümüne (etiket: `WMINING`) kopyalar. Agent açılışta dosyayı okur ve `/register` çağırmadan doğrudan bağlanır.

```
# WhisperMining rig ayar dosyası
RIG_ID=35db0b28-116f-4656-ae77-ab030d4e4a9b
RIG_SECRET=N3kQ…(43 karakter)
RIG_NAME=Salon-1
SERVER_URL=https://www.whisperkripto.com/mining
```

- Biçim: `ANAHTAR=değer` satırları, `#` ile başlayanlar yorum. Dosya Windows'ta düzenlenmiş olabilir: agent CRLF satır
  sonlarını ve UTF-8 BOM'u kabul etmeli.
- `RIG_NAME` bilgi amaçlıdır; geçerli ad her zaman paneldekidir (`/config` → `rig_name`).
- Anahtar panelden yenilenirse eski dosya `401` alır. Bu durumda agent **yeniden kayıt olmaz**: ekrana/loga
  "rig.conf geçersiz" yazar, 15 saniyede bir dosyayı yeniden okur (kullanıcı yeni dosyayı kopyalayıp yeniden başlatabilir).
- Agent her `PUT /hardware`'de `hw_fingerprint` gönderir. Aynı rig.conf farklı bir donanımdan bağlanırsa panelde
  "Donanım değişti" uyarısı çıkar (dosya iki rig'e kopyalandıysa ya da anakart değiştiyse).

**B) Eşleştirme kodu ile (monitörlü rig'ler için).** `rig.conf`'ta kimlik yoksa agent `/register` çağırır, ekrana bir kod
yazar, kullanıcı kodu panele girer. Kayıttan dönen `rig_id` ve `rig_secret` agent tarafından `rig.conf`'a yazılır ve
dosyaya `SOURCE=agent` satırı eklenir. Agent `401` aldığında bu satıra bakarak A mı B mi olduğunu anlar.

## Önerilen döngü

```
açılış
 ├─ rig.conf'ta RIG_ID + RIG_SECRET var → doğrudan bağlan (A)
 ├─ rig.conf'ta kimlik yok → POST /register → kimliği rig.conf'a yaz → kodu ekrana yaz (B)
 ├─ GET /status (5 sn'de bir) → paired=false ise kodu göster (kod değişmiş olabilir)
 ├─ PUT /hardware              (açılışta, eşleşmeden önce de)
 └─ eşleşince her poll_interval_sec (varsayılan 10 sn):
      POST /stats → yanıt:
        hardware_required=true     → PUT /hardware
        config_version değişti     → GET /config → miner'ı indir/doğrula/yeniden başlat, OC uygula
        pending_commands > 0       → GET /commands → uygula → POST /commands/{id}/result
 └─ 6 saatte bir: GET /update
```

Ağ hatasında üstel bekleme (5 → 10 → 20 … en fazla 60 sn) kullanın. Miner çalışmaya devam etmeli, sunucuya ulaşılamaması madenciliği durdurmamalı.

---

## 1. Kayıt: `POST /register`

Kimlik gerektirmez. IP başına saatte 20 istek sınırı vardır.

İstek:
```json
{
  "hw_fingerprint": "b8c1…",      // zorunlu, ≥8 karakter: anakart seri no + MAC'lerden türetilen sabit hash
  "hostname": "rig-salon",
  "agent_version": "1.0.0",
  "os_info": "Ubuntu 22.04.4 LTS"
}
```

Yanıt `201`:
```json
{
  "rig_id": "35db0b28-116f-4656-ae77-ab030d4e4a9b",
  "rig_secret": "N3k…(43 karakter)",
  "pairing_code": "K7F2-9QX",
  "pairing_expires_at": 1793000000,
  "poll_interval_sec": 10
}
```

Aynı `hw_fingerprint` ile eşleşmemiş eski bir kayıt varsa silinir. Böylece flash bellek yeniden yazıldığında çöp kayıt birikmez. Eşleşmiş bir rig'in kaydına dokunulmaz.

## 2. Durum: `GET /status`

```json
{
  "paired": false,
  "rig_name": "rig-salon",
  "pairing_code": "K7F2-9QX",     // eşleşince null
  "pairing_expires_at": 1793000000,
  "config_version": 1,
  "pending_commands": 0,
  "poll_interval_sec": 10,
  "server_time": 1792998200
}
```

Kodun süresi (30 dk) dolduysa bu çağrı yeni bir kod üretir. Ekrandaki kodu her yanıtta güncelleyin.

## 3. Donanım: `PUT /hardware`

Kartların **tam listesi** gönderilir. Listede olmayan kart sunucuda "kayıp" olarak işaretlenir ve uyarı oluşur.

```json
{
  "hw_fingerprint": "b8c1…",       // kayıttaki ile aynı sabit donanım hash'i (rig.conf ile kurulumda zorunlu)
  "agent_version": "1.0.0",
  "os_info": "Ubuntu 22.04.4 LTS",
  "cpu_model": "Intel Celeron G3930",
  "ram_total_mb": 3900,
  "gpus": [
    { "index": 0, "bus_id": "01:00.0", "vendor": "amd",    "model": "AMD Radeon RX 580 8GB", "vram_mb": 8192, "driver": "amdgpu 22.20", "vbios": "113-1E3871U-O4C" },
    { "index": 1, "bus_id": "03:00.0", "vendor": "nvidia", "model": "NVIDIA P106-100", "vram_mb": 6144, "driver": "535.183.01", "uuid": "GPU-…" }
  ]
}
```

- `bus_id` kartın kalıcı kimliğidir (PCI adresi, `lspci` / `nvidia-smi --query-gpu=pci.bus_id`). İstatistikler ve OC bu alanla eşleşir.
- `vendor`: `nvidia` veya `amd`. En fazla 32 kart.
- Yanıt: `{ "ok": true, "gpus": 6, "config_version": 4, … }`. Kart listesi değiştiyse `config_version` artar (OC listesi yenilenir).

## 4. İstatistik: `POST /stats`

```json
{
  "miner": { "status": "running", "uptime_sec": 5230, "error": null },   // error: panelde gösterilen son hata metni
  "system": { "cpu_load": 0.42, "ram_used_mb": 1350 },
  "gpus": [
    { "bus_id": "01:00.0", "hashrate": 30512000, "temp": 61, "mem_temp": null, "fan": 65, "power": 118,
      "core_clk": 1150, "mem_clk": 2100, "accepted": 412, "rejected": 1 }
  ]
}
```

| Alan | Birim / değerler |
|---|---|
| `miner.status` | `running` · `starting` · `downloading` · `stopped` · `error` |
| `hashrate` | **H/s** (MH/s değil). 30.5 MH/s → `30500000` |
| `temp`, `mem_temp` | °C. Bellek sıcaklığı okunamıyorsa `null` |
| `fan` | % (0–100) |
| `power` | W |
| `core_clk`, `mem_clk` | MHz |
| `accepted`, `rejected` | miner başladığından beri toplam share |

Yanıt:
```json
{ "ok": true, "hardware_required": false, "config_version": 5, "pending_commands": 1, "poll_interval_sec": 10, "server_time": 1792998300 }
```

Sunucu ham veriyi 48 saat, 5 dakikalık özetleri 30 gün saklar. Bilinmeyen `bus_id`'ler yok sayılır ve `hardware_required: true` döner.

## 5. Ayarlar: `GET /config`

```json
{
  "config_version": 5,
  "rig_name": "Karma-Rig",
  "flight_sheet": {
    "id": 1, "name": "ETC · 2miners", "coin": "ETC", "algo": "etchash",
    "wallet": "0x7a3f…",
    "pools": ["stratum+tcp://etc.2miners.com:1010", "stratum+tcp://eu-etc.2miners.com:1010"],
    "worker": "Karma-Rig",
    "pool_pass": "x",
    "miners": [
      { "name": "T-Rex", "api_type": "trex", "version": "0.26.8", "gpu_vendor": "nvidia",
        "download_url": "https://github.com/…/t-rex-0.26.8-linux.tar.gz", "sha256": "…", "extra_args": "" },
      { "name": "TeamRedMiner", "api_type": "teamredminer", "version": "0.10.21", "gpu_vendor": "amd",
        "download_url": "https://github.com/…", "sha256": "…", "extra_args": "" }
    ]
  },
  "overclock": [
    { "bus_id": "01:00.0", "vendor": "amd", "profile": "RX 580 · ETC",
      "params": { "core_clock": 1150, "mem_clock": 2100, "core_mv": 870, "mem_mv": 900, "fan_pct": 65 } },
    { "bus_id": "03:00.0", "vendor": "nvidia", "profile": null, "params": null }
  ]
}
```

Agent'ın uyması gereken kurallar:

- `flight_sheet: null` ise miner durdurulur.
- `gpu_vendor`: `all` · `nvidia` · `amd`. Her kart türü için en fazla bir miner gelir. Agent her miner'ı sadece kendi kart türüne atanmış kartlarla başlatır (T-Rex `--devices`, TRM `-d` gibi).
- **İndirme:** `download_url` sadece https'tir. Dosya indirilir, `sha256` doğrulanır, eşleşmezse **çalıştırılmaz** ve `miner.status = "error"` bildirilir. `sha256` boşsa indirme yapılmaz. İndirilen miner flash bellekte `miners/<ad>/<sürüm>/` altında saklanır, aynı sürüm tekrar indirilmez.
- `overclock[].params: null` → stok ayara dön. Boş bırakılan alanlara dokunulmaz.
  - NVIDIA: `core_offset`, `mem_offset` (MHz, nvidia-settings), `power_limit_w` (nvidia-smi -pl), `fan_pct`
  - AMD: `core_clock`, `mem_clock` (MHz), `core_mv`, `mem_mv` (mV, amdgpu sysfs `pp_od_clk_voltage`), `fan_pct`
- Rig'e sadece madencilik için gerekenler gönderilir: havuz, cüzdan adresi, worker, miner bilgisi, OC. Kullanıcı bilgisi, e-posta veya başka rig'lerin bilgisi asla gönderilmez.

## 6. Komutlar: `GET /commands`

```json
{ "commands": [ { "id": 42, "type": "reboot", "payload": {}, "created_at": 1792998100 } ] }
```

Dönen komutlar `sent` durumuna geçer ve bir daha dönmez. 10 dakika içinde alınmayan komutlar `expired` olur.

| `type` | Agent ne yapar |
|---|---|
| `miner_start` | Flight sheet'e göre miner'ı başlatır (yoksa `failed`) |
| `miner_stop` | Miner'ı durdurur. Kullanıcı başlatana kadar kendiliğinden başlatmaz |
| `miner_restart` | Durdurur ve yeniden başlatır |
| `reboot` | **Önce** sonucu bildirir, sonra `systemctl reboot` |
| `apply_oc` | Güncel OC ayarlarını yeniden uygular |

## 7. Komut sonucu: `POST /commands/{id}/result`

```json
{ "status": "done", "exit_code": 0, "output": "Miner durduruldu" }
```

`status`: `done` veya `failed`. `output` en fazla 4000 karakter. Zaten bitmiş bir komut için `409 already_finished` döner.

## 8. Güncelleme: `GET /update?version=1.0.0&channel=stable`

```json
{ "update_available": true, "version": "1.1.0", "download_url": "https://…/agent-1.1.0.tar.gz", "sha256": "…", "notes": "…" }
```

veya `{ "update_available": false }`. Agent paketi indirir, SHA-256'yı doğrular, yeni sürümü ayrı bir klasöre açar, servisi yeniden başlatır. Yeni sürüm 2 dakika içinde `/status`'a ulaşamazsa eski sürüme döner.

---

## Hata kodları

| HTTP | `error` | Anlamı |
|---|---|---|
| 400 | `hw_fingerprint_required`, `gpus_required`, `invalid_json` | Eksik veya hatalı gövde |
| 401 | `invalid_credentials` | Kimlik yanlış ya da rig silinmiş → yeniden kayıt |
| 403 | `not_paired` | Rig henüz bir hesaba bağlanmadı |
| 404 | `command_not_found` | Komut bu rig'e ait değil |
| 409 | `already_finished` | Komut sonucu zaten bildirilmiş |
| 413 | `too_large` | Gövde 64 KB'tan büyük |
| 429 | `rate_limited` | Çok sık kayıt denemesi (`Retry-After` başlığına bakın) |
