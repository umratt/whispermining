'use strict';
const telegram = require('./telegram');

// Bildirim katmanı. Şimdilik Telegram; başka kanal eklemek için buraya yeni bir gönderici eklenir.
// Gönderildiyse true döner
async function send(user, text) {
  if (telegram.bot().token && user && user.telegram_chat_id) {
    try {
      await telegram.send(user.telegram_chat_id, text);
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
