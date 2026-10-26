'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./config');
require('./db'); // şemayı hazırla
const sec = require('./security');
const { seedCatalog } = require('./services/seed');
const stats = require('./services/stats');
const alerts = require('./services/alerts');

seedCatalog();

const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});

const base = express.Router();
base.get('/health', (_req, res) => res.json({ ok: true }));
base.use('/api/agent/v1', require('./routes/agent').router);
base.use('/api', sec.loadSession, require('./routes/panel').router);
base.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

const pub = path.join(__dirname, '..', 'public');
const chartJs = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const indexHtml = fs.readFileSync(path.join(pub, 'index.html'), 'utf8').replace('%BASE%', `${config.basePath}/`);
base.use('/vendor/chart.umd.js', (_req, res) => res.sendFile(chartJs, { maxAge: '7d' }));
// Flash imajı ve agent paketleri (büyük dosyalar; kesilen indirme kaldığı yerden devam edebilir)
base.use('/downloads', express.static(config.downloadsDir, { index: false, dotfiles: 'deny', maxAge: '1h', acceptRanges: true }));
base.use('/downloads', (_req, res) => res.status(404).type('text').send('Dosya bulunamadı'));
// maxAge 0: tarayıcı her seferinde ETag ile kontrol eder (304), güncelleme sonrası eski JS kalmaz
base.use(express.static(pub, { index: false, maxAge: 0 }));
// Tek sayfa uygulama: diğer tüm adresler index.html
base.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(indexHtml);
});

// /mining → /mining/ (göreli adresler doğru çözülsün)
if (config.basePath) {
  app.get(config.basePath, (req, res, next) => {
    if (req.path !== config.basePath) return next(); // Express "/mining/" ile de eşleştirir; döngüye girmesin
    res.redirect(302, `${config.basePath}/`);
  });
  app.get('/', (_req, res) => res.redirect(302, `${config.basePath}/rigs`)); // yerel geliştirme kolaylığı; nginx bu adresi buraya göndermez
}
app.use(config.basePath || '/', base);

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
  console.error('[error]', err);
  res.status(500).json({ error: 'server_error', message: 'Sunucu hatası.' });
});

// Arka plan işleri
const every = (sec, fn) => setInterval(() => { try { fn(); } catch (e) { console.error('[job]', e.message); } }, sec * 1000);
every(60, stats.rollup);
every(30, alerts.runChecks);
every(3600, stats.purge);
setTimeout(() => { stats.rollup(); stats.purge(); }, 5000);

// "localhost": hem IPv4 hem IPv6 geri döngü adresini dinle (dışarıya açılmaz)
const hosts = config.host === 'localhost' ? ['127.0.0.1', '::1'] : [config.host];
const servers = hosts.map((h) => app.listen(config.port, h, () => {
  console.log(`[mining] http://${h.includes(':') ? `[${h}]` : h}:${config.port}${config.basePath}/ hazır`);
}).on('error', (err) => { if (h !== '::1') throw err; })); // IPv6 yoksa sorun değil
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { servers.forEach((s) => s.close()); process.exit(0); });
}
