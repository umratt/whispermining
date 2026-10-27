'use strict';
// Telegram bot: anahtar panelden girilir (şifreli saklanır), kullanıcı "Telegram'ı bağla" deyip bota /start yazınca
// sohbet kimliği kendiliğinden kaydedilir. Bot sadece bu panel için açılmış olmalı (getUpdates başka programla paylaşılamaz).
const crypto = require('crypto');
const config = require('../config');
const { get, run } = require('../db');
const vault = require('./confvault');

const API = 'https://api.telegram.org/bot';
const LINK_TTL_MS = 10 * 60 * 1000;
const pending = new Map(); // kod → { userId, expires }
let poller = null;
let offset = 0;
let cache = null; // { token, username }

function setting(key) {
  return get('SELECT value FROM app_settings WHERE key = ?', key)?.value ?? null;
}

function bot() {
  if (cache) return cache;
  const stored = vault.open(setting('telegram_bot_token'), 'telegram');
  const token = stored || config.telegramBotToken || '';
  cache = token ? { token, username: setting('telegram_bot_username') } : { token: '', username: null };
  return cache;
}

async function call(token, method, body) {
  const res = await fetch(`${API}${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(data.description || `Telegram HTTP ${res.status}`);
    err.code = data.error_code || res.status;
    throw err;
  }
  return data.result;
}

// Yöneticinin girdiği anahtarı doğrular ve kaydeder
async function setToken(token) {
  token = String(token || '').trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('Bu bir bot anahtarına benzemiyor. BotFather\'ın verdiği "123456:ABC..." biçimindeki anahtarı yapıştırın.');
  let me;
  try { me = await call(token, 'getMe'); } catch { throw new Error('Telegram bu anahtarı kabul etmedi. Anahtarı BotFather\'dan tekrar kopyalayın.'); }
  run(`INSERT INTO app_settings (key, value) VALUES ('telegram_bot_token', ?), ('telegram_bot_username', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`, vault.seal(token, 'telegram'), me.username);
  cache = null;
  return me.username;
}

function clearToken() {
  run("DELETE FROM app_settings WHERE key IN ('telegram_bot_token', 'telegram_bot_username')");
  cache = null;
}

async function send(chatId, text) {
  const { token } = bot();
  if (!token) throw new Error('Telegram botu tanımlı değil.');
  await call(token, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
}

// Bağlantı kodu üretir; kullanıcı t.me bağlantısında "Başlat"a basınca bot "/start KOD" alır
function startLink(userId) {
  const { token, username } = bot();
  if (!token || !username) throw new Error('Önce yönetici Telegram bot anahtarını girmeli.');
  for (const [k, v] of pending) if (v.userId === userId || v.expires < Date.now()) pending.delete(k);
  const code = crypto.randomBytes(9).toString('base64url');
  pending.set(code, { userId, expires: Date.now() + LINK_TTL_MS });
  ensurePolling();
  return { url: `https://t.me/${username}?start=${code}`, expires_in: LINK_TTL_MS / 1000 };
}

function ensurePolling() {
  if (poller) return;
  poller = setInterval(poll, 3000);
  poller.unref?.();
}

let busy = false;
async function poll() {
  if (busy) return;
  for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
  if (!pending.size) { clearInterval(poller); poller = null; return; }
  const { token } = bot();
  if (!token) return;
  busy = true;
  try {
    const updates = await call(token, 'getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
    for (const u of updates) {
      offset = u.update_id + 1;
      const m = u.message;
      const match = m?.text?.match(/^\/start\s+(\S+)/);
      const p = match && pending.get(match[1]);
      if (!p || m.chat?.type !== 'private') continue;
      pending.delete(match[1]);
      run('UPDATE users SET telegram_chat_id = ? WHERE id = ?', String(m.chat.id), p.userId);
      send(m.chat.id, '✅ WhisperMining bağlandı. Rig uyarıları (çevrimdışı, sıcaklık, hashrate düşüşü…) buraya gelecek.').catch(() => {});
    }
  } catch (err) {
    console.error('[telegram] getUpdates:', err.message);
  } finally { busy = false; }
}

module.exports = { bot, setToken, clearToken, send, startLink };
