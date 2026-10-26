'use strict';
const config = require('../config');

// Bildirim katmanı. Şimdilik Telegram; başka kanal eklemek için buraya yeni bir gönderici eklenir.
async function sendTelegram(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
}

// Gönderildiyse true döner
async function send(user, text) {
  if (config.telegramBotToken && user && user.telegram_chat_id) {
    try {
      await sendTelegram(user.telegram_chat_id, text);
      return true;
    } catch (err) {
      console.error('[notify] Telegram gönderilemedi:', err.message);
      return false;
    }
  }
  if (process.env.NODE_ENV !== 'production') console.log('[notify]', text.replace(/\n/g, ' | '));
  return false;
}

module.exports = { send };
