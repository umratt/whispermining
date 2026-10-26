'use strict';
const crypto = require('crypto');
const { get, run, now } = require('./db');
const config = require('./config');

const SESSION_COOKIE = 'wm_session';

// ---- Şifreler (scrypt, Node'un yerleşik kütüphanesi) ----
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

// ---- Panel oturumları ----
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieString(value, maxAgeSec) {
  const attrs = [`${SESSION_COOKIE}=${value}`, `Path=${config.basePath || '/'}`, 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${maxAgeSec}`];
  if (config.cookieSecure) attrs.push('Secure');
  return attrs.join('; ');
}

function createSession(res, userId, req) {
  const token = randomToken();
  const csrf = randomToken(24);
  const ttl = config.sessionDays * 86400;
  run(`INSERT INTO sessions (id, user_id, csrf, expires_at, ip, user_agent, created_at) VALUES (?,?,?,?,?,?,?)`,
    sha256(token), userId, csrf, now() + ttl, req.ip, String(req.get('user-agent') || '').slice(0, 200), now());
  res.setHeader('Set-Cookie', cookieString(token, ttl));
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
  res.setHeader('Set-Cookie', cookieString('', 0));
}

// Oturumu çöz; varsa req.user ve req.session doldurur
function loadSession(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) {
    const row = get(`SELECT s.id AS sid, s.csrf, s.expires_at, u.id, u.email, u.is_admin
                     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`, sha256(token));
    if (row && row.expires_at > now()) {
      req.user = { id: row.id, email: row.email, is_admin: !!row.is_admin };
      req.session = { id: row.sid, csrf: row.csrf };
    }
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized', message: 'Oturum açmanız gerekiyor.' });
  // Durum değiştiren istekler için CSRF başlığı zorunlu
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const sent = req.get('x-csrf-token') || '';
    const a = Buffer.from(sent); const b = Buffer.from(req.session.csrf);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: 'csrf', message: 'Güvenlik doğrulaması başarısız. Sayfayı yenileyin.' });
    }
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'forbidden', message: 'Bu işlem için yönetici yetkisi gerekiyor.' });
  next();
}

// ---- Basit hız sınırlayıcı (bellekte) ----
function rateLimit({ windowSec, max, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => {
    const t = now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }, 60_000).unref();
  return (req, res, next) => {
    const k = key(req); const t = now();
    let h = hits.get(k);
    if (!h || h.reset <= t) { h = { count: 0, reset: t + windowSec }; hits.set(k, h); }
    if (++h.count > max) {
      res.setHeader('Retry-After', String(h.reset - t));
      return res.status(429).json({ error: 'rate_limited', message: 'Çok fazla istek. Biraz sonra tekrar deneyin.' });
    }
    next();
  };
}

// ---- Eşleştirme kodu: K7F2-9QX biçimi, karışan karakterler (0/O, 1/I/L) yok ----
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generatePairingCode() {
  const pick = (n) => Array.from(crypto.randomBytes(n), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${pick(4)}-${pick(3)}`;
}
const normalizePairingCode = (s) => {
  const c = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 7 ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
};

module.exports = {
  hashPassword, verifyPassword, sha256, randomToken, safeEqualHex,
  createSession, destroySession, loadSession, requireUser, requireAdmin, rateLimit,
  generatePairingCode, normalizePairingCode,
};
