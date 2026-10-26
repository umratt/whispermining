# WhisperMining

HiveOS benzeri madencilik rig yönetim paneli. `https://www.whisperkripto.com/mining` altında çalışır.

- **Panel:** rig listesi, kart kart canlı istatistik, 24 saatlik grafikler, eşleştirme koduyla rig ekleme, flight sheet,
  OC profilleri (NVIDIA / AMD), uzaktan komutlar, uyarılar (Telegram'a hazır), miner kataloğu, açık/koyu tema, telefon uyumlu.
- **Agent API:** rig'lerdeki agent'ın (Aşama 2) kullanacağı API. Belgesi: [docs/agent-api.md](docs/agent-api.md)
- **Simülatör:** gerçek rig olmadan paneli test etmek için sahte agent: [simulator/fake-agent.js](simulator/fake-agent.js)

Teknoloji: Node.js 22 + Express, yerleşik SQLite (`node:sqlite`, ek derleme gerektirmez), sade JS + Chart.js.
Sunucunun 2 GB RAM'i ve mevcut botları düşünülerek hafif tutuldu (~60 MB bellek).

## Yerelde çalıştırma

```bash
npm install
npm run create-user -- admin@ornek.local "en-az-10-karakter" --admin
npm start                       # http://localhost:3120/mining/
npm run sim                     # ayrı terminalde: 3 sahte rig (2× RX 580, 12× P106-100, 3× RTX 3080)
```

Simülatör her rig için ekrana bir eşleştirme kodu basar. Panelde **Rig ekle**'ye bu kodu girin.
Grafikleri hemen dolu görmek için: `npm run demo-backfill` (son 24 saati sahte veriyle doldurur, sadece geliştirme için).

Simülatör seçenekleri: `--hot 3` (3. rig'in bir kartı ısınır), `--drop-gpu 2` (2 dk sonra bir kart kaybolur), `--reset` (yeniden kayıt).

## Klasörler

```
server/        API ve arka plan işleri (istatistik özetleme, uyarılar, temizlik)
  routes/agent.js   rig'lerin konuştuğu API (/mining/api/agent/v1)
  routes/panel.js   panelin API'si (/mining/api)
  services/         eşleştirme/ayar üretimi, istatistik, uyarılar, bildirim, katalog
public/        panel arayüzü
simulator/     sahte agent
scripts/       kullanıcı oluşturma, demo verisi
deploy/        nginx bloğu, PM2 tanımı, kurulum adımları (DEPLOY.md)
docs/          agent API belgesi
```

## Güvenlik özeti

- Şifreler scrypt ile hash'lenir. Oturum çerezi HttpOnly + Secure + SameSite, `Path=/mining` ile sınırlı. Değişiklik yapan isteklerde CSRF anahtarı istenir. Giriş denemeleri hız sınırlıdır.
- Her rig'in kendine özel 256 bitlik anahtarı var, sunucuda sadece hash'i tutulur.
- Panel işlemleri her zaman rig sahibine göre filtrelenir: başkasının rig'i "bulunamadı" döner.
- Rig'e sadece havuz, cüzdan adresi, worker, miner indirme bilgisi (SHA256 ile) ve OC değerleri gönderilir.

## Agent (rig tarafı) ve flash imajı

- `agent/whisperagent/`: rig'de çalışan Python agent'ı (sadece standart kütüphane, Ubuntu 22.04 / Python 3.10).
  rig.conf okur, kartları tarar (nvidia-smi, amdgpu sysfs), miner'ı SHA256 doğrulayarak indirir ve çalıştırır
  (T-Rex, lolMiner, TeamRedMiner), OC uygular (NVML / nvidia-settings, amdgpu sysfs), komutları yürütür, kendini günceller.
- Testler: `cd agent && python -m unittest discover -s tests`
- Gerçek kart olmadan deneme: `WM_FAKE_HW=karma WM_CONF=rig.conf WM_STATE_DIR=./state WM_RUN_DIR=./run python -m whisperagent`
- `image/build-image.sh`: Ubuntu 22.04 tabanlı flash imajını üretir (NVIDIA 535, Polaris için AMD legacy OpenCL,
  WMINING FAT bölümü, loglar RAM'de). Linux'ta root ister; en kolayı GitHub Actions (`.github/workflows/build-image.yml`).
- `image/package-agent.sh`: agent güncelleme paketi (panelde Agent sürümleri → Sürüm yayınla).

İmaj ve agent paketleri VPS'te `/opt/mining/downloads/` altına konur, `https://www.whisperkripto.com/mining/downloads/<dosya>` adresinden iner.
