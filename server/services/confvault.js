'use strict';
// rig.conf'taki anahtarı, sahibi istediği zaman tekrar indirebilsin diye şifreli saklar (AES-256-GCM).
// Şifre anahtarı veritabanından ayrı tutulur: CONF_KEY ortam değişkeni ya da veri klasöründeki conf.key dosyası.
// Böylece sadece veritabanı yedeği ele geçirilirse rig anahtarları okunamaz.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');

let key = null;
function getKey() {
  if (key) return key;
  if (process.env.CONF_KEY) {
    key = Buffer.from(process.env.CONF_KEY, 'base64');
  } else {
    const file = path.join(path.dirname(config.dbPath), 'conf.key');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  }
  if (key.length !== 32) throw new Error('CONF_KEY 32 bayt (base64) olmalı');
  return key;
}

function seal(secret, rigId) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  c.setAAD(Buffer.from(rigId)); // başka rig'in satırına kopyalanırsa çözülmez
  const enc = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

function open(sealed, rigId) {
  if (!sealed) return null;
  try {
    const [ver, iv, tag, enc] = sealed.split('.');
    if (ver !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(rigId));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { seal, open };
