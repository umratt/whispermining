'use strict';
// Kullanım: npm run create-user -- eposta@ornek.com "guclu-sifre" [--admin]
const { get, run, now } = require('../server/db');
const { hashPassword } = require('../server/security');

const [email, password] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const admin = process.argv.includes('--admin');
if (!email || !password || password.length < 10) {
  console.error('Kullanım: npm run create-user -- eposta@ornek.com "en-az-10-karakter-sifre" [--admin]');
  process.exit(1);
}
const existing = get('SELECT id FROM users WHERE email = ?', email.toLowerCase());
if (existing) {
  run('UPDATE users SET password_hash = ?, is_admin = MAX(is_admin, ?) WHERE id = ?', hashPassword(password), admin ? 1 : 0, existing.id);
  run('DELETE FROM sessions WHERE user_id = ?', existing.id);
  console.log('Şifre güncellendi:', email);
} else {
  run('INSERT INTO users (email, password_hash, is_admin, created_at) VALUES (?,?,?,?)', email.toLowerCase(), hashPassword(password), admin ? 1 : 0, now());
  console.log('Kullanıcı oluşturuldu:', email, admin ? '(yönetici)' : '');
}
