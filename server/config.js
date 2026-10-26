'use strict';
const path = require('path');
const fs = require('fs');

// .env dosyası varsa basitçe yükle (harici paket kullanmadan)
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
const basePath = (env.BASE_PATH || '/mining').replace(/\/+$/, '');

module.exports = {
  port: Number(env.PORT || 3120),
  host: env.HOST || 'localhost',
  basePath,
  dbPath: path.resolve(env.DB_PATH || path.join(__dirname, '..', 'data', 'mining.db')),
  downloadsDir: path.resolve(env.DOWNLOADS_DIR || path.join(__dirname, '..', 'downloads')),
  // Üretimde nginx HTTPS arkasında: çerezler Secure olmalı
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
  trustProxy: env.TRUST_PROXY || 'loopback',
  sessionDays: Number(env.SESSION_DAYS || 14),
  publicUrl: env.PUBLIC_URL || `http://localhost:${env.PORT || 3120}${basePath}`,
  telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
  // Agent tarafı ayarları
  agentPollSec: Number(env.AGENT_POLL_SEC || 10),
  pairingTtlSec: 30 * 60,
  commandTtlSec: 10 * 60,
  // Veri saklama
  rawRetentionSec: 48 * 3600,
  rollupRetentionSec: 30 * 86400,
};
