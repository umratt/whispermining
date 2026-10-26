# VPS'e yayına alma (whisperkripto.com/mining)

Sunucu: AlmaLinux 8, 2 GB RAM, nginx + certbot, PM2 (Node 20 ile botlar). Bu kurulum:

- sitenin dosyalarına, bot süreçlerine ve sistemdeki Node 20'ye **dokunmaz**,
- kendi klasöründe (`/opt/mining`) ve kendi Node 22'siyle çalışır,
- sadece `127.0.0.1:3120`'yi dinler, dışarıya port açmaz,
- nginx'e tek bir `/mining/` bloğu ekler (yedek alınır, test edilmeden yüklenmez).

## 1. Klasörler ve Node 22 (sadece bu uygulama için)

```bash
mkdir -p /opt/mining/{app,data,logs,node}
cd /tmp && curl -fsSLO https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-x64.tar.xz
curl -fsSL https://nodejs.org/dist/v22.21.1/SHASUMS256.txt | grep node-v22.21.1-linux-x64.tar.xz | sha256sum -c -
tar -xJf node-v22.21.1-linux-x64.tar.xz -C /opt/mining/node --strip-components=1 && rm node-v22.21.1-linux-x64.tar.xz
/opt/mining/node/bin/node -v   # v22.21.1
```

## 2. Uygulama dosyaları

Yerelden (`mining/` klasörü, `node_modules`, `data` ve `.env` hariç) `/opt/mining/app` altına kopyalanır, sonra:

```bash
cd /opt/mining/app
PATH=/opt/mining/node/bin:$PATH npm ci --omit=dev --no-audit --no-fund
cp .env.example .env && chmod 600 .env
```

## 3. Başlatma ve ilk hesap

```bash
pm2 start /opt/mining/app/deploy/ecosystem.config.js && pm2 save
curl -s http://127.0.0.1:3120/mining/health     # {"ok":true}
```

İlk hesabı tarayıcıdan "ilk kurulum" ekranında oluşturabilir ya da komutla açabilirsiniz:

```bash
cd /opt/mining/app && /opt/mining/node/bin/node --disable-warning=ExperimentalWarning scripts/create-user.js eposta@ornek.com 'guclu-sifre' --admin
```

## 4. nginx (tek temas noktası)

```bash
cp /etc/nginx/conf.d/whisperkripto.conf /etc/nginx/conf.d/whisperkripto.conf.bak-mining-$(date +%Y%m%d%H%M)
```

`deploy/nginx-mining-location.conf` içindeki iki `location` bloğu, 443 `server` bloğunda `location /bj-sync/`'in altına eklenir. Sonra:

```bash
nginx -t && systemctl reload nginx
```

`nginx -t` hata verirse **reload yapılmaz**, site eski ayarla çalışmaya devam eder. Yedek geri konup tekrar denenir.

Kontrol:
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://www.whisperkripto.com/            # site: eskisi gibi
curl -s https://www.whisperkripto.com/mining/health                                 # {"ok":true}
```

## İmaj ve agent paketlerini yayınlama

```bash
mkdir -p /opt/mining/downloads
# yerelden: scp whispermining-1.0.0.img.xz root@SUNUCU:/opt/mining/downloads/
```

`deploy/nginx-mining-location.conf` içindeki `location ^~ /mining/downloads/` bloğu nginx'te olmalı
(büyük dosyaları nginx doğrudan diskten sunar). Sonra panelde **Flash kurulumu → İmaj yayınla** ile adres
(`https://www.whisperkripto.com/mining/downloads/whispermining-1.0.0.img.xz`) ve SHA256 girilir.

## Geri alma (tek adım)

```bash
pm2 delete mining && pm2 save
cp /etc/nginx/conf.d/whisperkripto.conf.bak-mining-<tarih> /etc/nginx/conf.d/whisperkripto.conf && nginx -t && systemctl reload nginx
```

`/opt/mining` klasörü silinirse kurulumdan geriye hiçbir şey kalmaz.

## Güncelleme

Değişen dosyalar kopyalanır, ardından `pm2 restart mining`. Veritabanı şeması açılışta otomatik güncellenir. Güncellemeden önce yedek alın: `cp /opt/mining/data/mining.db /opt/mining/data/mining.db.bak`.
