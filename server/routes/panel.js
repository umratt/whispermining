'use strict';
const crypto = require('crypto');
const express = require('express');
const { get, all, run, tx, now } = require('../db');
const config = require('../config');
const sec = require('../security');
const rigsSvc = require('../services/rigs');
const vault = require('../services/confvault');
const telegram = require('../services/telegram');
const profit = require('../services/profit');
const autoswitch = require('../services/autoswitch');
const { COMMAND_TYPES, CONSOLE_COMMANDS } = require('./agent');

const router = express.Router();
router.use(express.json({ limit: '64kb' }));

const ONLINE_SEC = 60;
const bad = (res, message, status = 400) => res.status(status).json({ error: 'invalid', message });
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const idOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// ---------- Kimlik ----------
const loginLimiter = sec.rateLimit({ windowSec: 900, max: 10 });

router.get('/setup-status', (_req, res) => {
  res.json({ needs_setup: get('SELECT COUNT(*) AS n FROM users').n === 0 });
});

// İlk kurulum: hiç kullanıcı yoksa ilk hesap (yönetici) oluşturulur. Sonra kapanır.
router.post('/setup', loginLimiter, (req, res) => {
  const email = str(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'Geçerli bir e-posta girin.');
  if (password.length < 10) return bad(res, 'Şifre en az 10 karakter olmalı.');
  const created = tx(() => {
    if (get('SELECT COUNT(*) AS n FROM users').n > 0) return null;
    return run('INSERT INTO users (email, password_hash, is_admin, created_at) VALUES (?,?,1,?)',
      email, sec.hashPassword(password), now());
  });
  if (!created) return bad(res, 'Kurulum zaten tamamlanmış.', 409);
  sec.createSession(res, Number(created.lastInsertRowid), req);
  res.json({ ok: true });
});

router.post('/login', loginLimiter, (req, res) => {
  const user = get('SELECT id, password_hash FROM users WHERE email = ?', str(req.body.email, 120).toLowerCase());
  // Kullanıcı yoksa da hash hesaplanır: yanıt süresinden e-posta varlığı anlaşılmasın
  const ok = sec.verifyPassword(String(req.body.password || ''),
    user ? user.password_hash : 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
  if (!user || !ok) return bad(res, 'E-posta veya şifre hatalı.', 401);
  sec.createSession(res, user.id, req);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  sec.destroySession(req, res);
  res.json({ ok: true });
});

router.use(sec.requireUser);

router.get('/me', (req, res) => {
  const u = get('SELECT id, email, is_admin, telegram_chat_id, temp_limit, hashrate_drop_pct, offline_after_sec FROM users WHERE id = ?', req.user.id);
  const openAlerts = get(`SELECT COUNT(*) AS n FROM alerts a JOIN rigs r ON r.id = a.rig_id
                          WHERE r.owner_id = ? AND a.resolved_at IS NULL`, req.user.id).n;
  const tg = telegram.bot();
  res.json({ ...u, is_admin: !!u.is_admin, csrf: req.session.csrf, open_alerts: openAlerts,
    telegram_enabled: !!tg.token, telegram_bot: tg.username });
});

// ---- Telegram ----
router.put('/admin/telegram', sec.requireAdmin, async (req, res) => {
  try { res.json({ ok: true, username: await telegram.setToken(req.body.token) }); } catch (err) { bad(res, err.message); }
});
router.delete('/admin/telegram', sec.requireAdmin, (_req, res) => { telegram.clearToken(); res.json({ ok: true }); });
router.post('/me/telegram/link', (req, res) => {
  try { res.json({ ok: true, ...telegram.startLink(req.user.id) }); } catch (err) { bad(res, err.message); }
});
router.post('/me/telegram/test', sec.rateLimit({ windowSec: 60, max: 5, key: (req) => `tgtest:${req.user.id}` }), async (req, res) => {
  const u = get('SELECT telegram_chat_id FROM users WHERE id = ?', req.user.id);
  if (!u.telegram_chat_id) return bad(res, "Önce Telegram'ı bağlayın.");
  try { await telegram.send(u.telegram_chat_id, '🔔 WhisperMining test mesajı: bildirimler çalışıyor.'); res.json({ ok: true }); } catch (err) { bad(res, `Gönderilemedi: ${err.message}`); }
});
router.delete('/me/telegram', (req, res) => {
  run('UPDATE users SET telegram_chat_id = NULL WHERE id = ?', req.user.id);
  res.json({ ok: true });
});

router.put('/me/settings', (req, res) => {
  const b = req.body;
  const tempLimit = Math.round(Number(b.temp_limit));
  const drop = Math.round(Number(b.hashrate_drop_pct));
  const offline = Math.round(Number(b.offline_after_sec));
  if (!(tempLimit >= 50 && tempLimit <= 100)) return bad(res, 'Sıcaklık sınırı 50–100°C arası olmalı.');
  if (!(drop >= 5 && drop <= 90)) return bad(res, 'Hashrate düşüş eşiği %5–90 arası olmalı.');
  if (!(offline >= 60 && offline <= 3600)) return bad(res, 'Çevrimdışı süresi 60–3600 saniye arası olmalı.');
  run('UPDATE users SET temp_limit=?, hashrate_drop_pct=?, offline_after_sec=? WHERE id=?', tempLimit, drop, offline, req.user.id);
  if (b.telegram_chat_id !== undefined) { // elle girilen sohbet kimliği (isteğe bağlı)
    const chat = str(b.telegram_chat_id, 40);
    if (chat && !/^-?\d+$/.test(chat)) return bad(res, 'Telegram chat ID sadece rakamlardan oluşmalı.');
    run('UPDATE users SET telegram_chat_id=? WHERE id=?', chat || null, req.user.id);
  }
  res.json({ ok: true });
});

router.put('/me/password', (req, res) => {
  const u = get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!sec.verifyPassword(String(req.body.current || ''), u.password_hash)) return bad(res, 'Mevcut şifre hatalı.', 401);
  const next = String(req.body.next || '');
  if (next.length < 10) return bad(res, 'Yeni şifre en az 10 karakter olmalı.');
  tx(() => {
    run('UPDATE users SET password_hash = ? WHERE id = ?', sec.hashPassword(next), req.user.id);
    run('DELETE FROM sessions WHERE user_id = ? AND id != ?', req.user.id, req.session.id); // diğer cihazlardan çıkış
  });
  res.json({ ok: true });
});

// ---------- Rig'ler ----------
function rigSummary(r, t) {
  const gpus = all('SELECT vendor, present, temp, stats_at FROM gpus WHERE rig_id = ?', r.id);
  const last = get('SELECT hashrate, power, temp_max, accepted, rejected FROM rig_stats WHERE rig_id = ? ORDER BY ts DESC LIMIT 1', r.id);
  const online = !!r.last_seen_at && r.last_seen_at >= t - ONLINE_SEC;
  return {
    id: r.id, name: r.name, online, last_seen_at: r.last_seen_at, miner_status: online ? r.miner_status : 'offline',
    agent_version: r.agent_version, last_ip: r.last_ip,
    hashrate: online && last ? last.hashrate : 0,
    power: online && last ? last.power : 0,
    temp_max: online && last ? last.temp_max : null,
    accepted: last ? last.accepted : 0, rejected: last ? last.rejected : 0,
    gpu_count: gpus.filter((g) => g.present).length,
    gpu_lost: gpus.filter((g) => !g.present).length,
    nvidia: gpus.filter((g) => g.present && g.vendor === 'nvidia').length,
    amd: gpus.filter((g) => g.present && g.vendor === 'amd').length,
    flight_sheet: r.fs_name || null, coin: r.fs_coin || null, algo: r.fs_algo || null,
    open_alerts: r.open_alerts,
  };
}

router.get('/rigs', (req, res) => {
  const t = now();
  const rows = all(`SELECT r.*, f.name AS fs_name, f.coin AS fs_coin, f.algo AS fs_algo,
                    (SELECT COUNT(*) FROM alerts a WHERE a.rig_id = r.id AND a.resolved_at IS NULL) AS open_alerts
                    FROM rigs r LEFT JOIN flight_sheets f ON f.id = r.flight_sheet_id
                    WHERE r.owner_id = ? ORDER BY r.name COLLATE NOCASE`, req.user.id);
  res.json({ rigs: rows.map((r) => rigSummary(r, t)) });
});

// rig.conf: anahtar şifreli saklanır, sahibi rig'i silene ya da anahtarı yenileyene kadar istediği zaman indirebilir.
// Dosya sunucudan "attachment" olarak verilir (tarayıcıda üretilen blob indirmesi her tarayıcıda çalışmıyor).
function confResponse(rig, secret) {
  return { conf: rigsSvc.rigConfText(rig, secret, config.publicUrl), conf_url: `api/rigs/${rig.id}/rig.conf` };
}

router.get('/rigs/:id/rig.conf', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  const secret = r && vault.open(r.secret_enc, r.id);
  if (!secret) {
    return res.status(404).type('text/plain; charset=utf-8')
      .send(r ? "Bu rig için kayıtlı rig.conf yok (eşleştirme koduyla eklenmiş ya da eski kayıt). Rig ayarlarından \"rig.conf'u yeniden oluştur\" ile yenisini alın."
        : 'Rig bulunamadı.');
  }
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="rig.conf"', 'Cache-Control': 'no-store' });
  res.send(rigsSvc.rigConfText(r, secret, config.publicUrl));
});

// İçeriği göstermek için (kopyalama yedeği)
router.get('/rigs/:id/rig-conf-text', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  const secret = r && vault.open(r.secret_enc, r.id);
  if (!secret) return bad(res, "Bu rig için kayıtlı rig.conf yok. \"rig.conf'u yeniden oluştur\" ile yenisini alın.", 404);
  res.set('Cache-Control', 'no-store');
  res.json(confResponse(r, secret));
});

// ---- Kazanç sıralaması: rig'lerdeki her kart modeli için tüm coin'lerin günlük kazancı ----
router.get('/profit', async (req, res) => {
  const models = all(`SELECT g.model, COUNT(*) AS count FROM gpus g JOIN rigs r ON r.id = g.rig_id
                      WHERE r.owner_id = ? AND g.present = 1 GROUP BY g.model ORDER BY count DESC`, req.user.id);
  try {
    const u = get('SELECT power_price FROM users WHERE id = ?', req.user.id);
    res.json({ ...(await profit.ranking(models)), power_price: u.power_price });
  } catch (err) {
    console.error('[profit]', err.message);
    bad(res, 'Kazanç verisi şu an alınamadı (WhatToMine ya da kur servisine ulaşılamadı). Birkaç dakika sonra tekrar deneyin.', 502);
  }
});

// WhatToMine hesaplayıcısı gibi: ?c=3080:1,10606:12 → seçilen kart setinin toplamıyla tüm coin'ler
router.get('/profit/calc', async (req, res) => {
  const selection = String(req.query.c || '').split(',').slice(0, 40).map((p) => {
    const [key, n] = p.split(':');
    return { key: String(key || '').slice(0, 12), count: Math.max(0, Math.min(500, Math.round(Number(n) || 0))) };
  }).filter((s) => s.key);
  try {
    res.json(await profit.calc(selection));
  } catch (err) {
    console.error('[profit]', err.message);
    bad(res, 'Kazanç verisi şu an alınamadı (WhatToMine ya da kur servisine ulaşılamadı). Birkaç dakika sonra tekrar deneyin.', 502);
  }
});

// Elektrik fiyatı (₺/kWh): kazanç sayfası ve otomatik coin değiştirme bunu kullanır
router.put('/me/power-price', (req, res) => {
  const v = Number(req.body.value);
  if (!(v >= 0 && v <= 100)) return bad(res, 'Elektrik fiyatı 0–100 ₺/kWh arası olmalı.');
  run('UPDATE users SET power_price = ? WHERE id = ?', Math.round(v * 100) / 100, req.user.id);
  res.json({ ok: true });
});

// ---- Otomatik coin değiştirme: tüm rig'ler, toplam kazancı en yüksek tek coin ----
const autoSwitchView = (r) => ({
  enabled: r.state.enabled, decision: r.decision, last_check: r.state.last_check || null, last_switch_at: r.state.last_switch_at || null,
  log: r.state.log || [], candidates: r.candidates, current_fs_id: r.current_fs_id, best_fs_id: r.best?.fs_id || null,
  created: r.created, usd_try: r.usd_try, power_price: r.power_price, rig_count: r.rig_count,
  min_gain: autoswitch.MIN_GAIN, min_hold_h: autoswitch.MIN_HOLD_SEC / 3600,
});
router.get('/auto-switch', async (req, res) => {
  try {
    const s = autoswitch.state(req.user.id);
    const ev = await autoswitch.evaluate(req.user.id);
    res.json(autoSwitchView({ ...ev, state: s, decision: s.last_decision || null }));
  } catch (err) { bad(res, `Kazanç verisi alınamadı: ${err.message}`, 502); }
});
router.put('/auto-switch', async (req, res) => {
  const on = !!req.body.enabled;
  run('UPDATE users SET auto_switch = ? WHERE id = ?', on ? 1 : 0, req.user.id);
  try {
    // Açılınca hemen bakılır (6 saat beklenmez); kapatınca rig'ler oldukları coin'de kalır
    res.json(autoSwitchView(await autoswitch.check(req.user.id, { force: on })));
  } catch (err) { bad(res, `Kazanç verisi alınamadı: ${err.message}`, 502); }
});
router.post('/auto-switch/check', async (req, res) => {
  try { res.json(autoSwitchView(await autoswitch.check(req.user.id, { force: !!req.body.force }))); } catch (err) { bad(res, err.message, 502); }
});

// ---- Rig ekranını izleme ----
// Pencere açıkken panel bunu birkaç saniyede bir çağırır; izleme 60 sn içinde yenilenmezse agent ekran göndermeyi bırakır.
router.get('/rigs/:id/screen', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  run('UPDATE rigs SET screen_watch_until = ? WHERE id = ?', now() + 60, r.id);
  res.set('Cache-Control', 'no-store');
  res.json({ text: r.screen_text, log: r.screen_log, at: r.screen_at, server_time: now(),
    online: !!r.last_seen_at && r.last_seen_at >= now() - ONLINE_SEC, agent_version: r.agent_version });
});

// rig.conf ile ekleme: rig önceden oluşturulur ve hesaba bağlanır. Agent dosyadaki anahtarla doğrudan bağlanır.
router.post('/rigs', sec.rateLimit({ windowSec: 600, max: 30, key: (req) => `rigcreate:${req.user.id}` }), (req, res) => {
  const name = str(req.body.name, 40);
  if (!name) return bad(res, 'Rig adı girin.');
  if (get('SELECT COUNT(*) AS n FROM rigs WHERE owner_id = ?', req.user.id).n >= 200) return bad(res, 'Rig sınırına ulaşıldı.');
  const rig = { id: crypto.randomUUID(), name };
  const secret = sec.randomToken(32);
  const t = now();
  run(`INSERT INTO rigs (id, owner_id, name, secret_hash, secret_enc, paired_at, created_at) VALUES (?,?,?,?,?,?,?)`,
    rig.id, req.user.id, name, sec.sha256(secret), vault.seal(secret, rig.id), t, t);
  res.json({ ok: true, rig_id: rig.id, ...confResponse(rig, secret) });
});

// Anahtarı yenile: eski rig.conf hemen geçersiz olur
router.post('/rigs/:id/rotate-secret', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  const secret = sec.randomToken(32);
  run('UPDATE rigs SET secret_hash = ?, secret_enc = ?, hw_changed_at = NULL WHERE id = ?', sec.sha256(secret), vault.seal(secret, r.id), r.id);
  res.json({ ok: true, ...confResponse(r, secret) });
});

router.post('/rigs/pair',sec.rateLimit({ windowSec: 600, max: 20, key: (req) => `pair:${req.user.id}` }), (req, res) => {
  const code = sec.normalizePairingCode(req.body.code);
  if (!code) return bad(res, 'Kod 7 karakter olmalı (ör. K7F2-9QX).');
  const name = str(req.body.name, 40);
  const rig = get('SELECT id, pairing_expires_at, hostname FROM rigs WHERE pairing_code = ? AND owner_id IS NULL', code);
  if (!rig || rig.pairing_expires_at < now()) return bad(res, 'Kod bulunamadı veya süresi dolmuş. Rig ekranındaki güncel kodu girin.', 404);
  run(`UPDATE rigs SET owner_id = ?, name = ?, pairing_code = NULL, pairing_expires_at = NULL, paired_at = ?,
       config_version = config_version + 1 WHERE id = ?`, req.user.id, name || rig.hostname || 'Yeni rig', now(), rig.id);
  res.json({ ok: true, rig_id: rig.id });
});

router.get('/rigs/:id', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  const t = now();
  const fs = r.flight_sheet_id ? get('SELECT name, coin, algo FROM flight_sheets WHERE id = ?', r.flight_sheet_id) : null;
  const summary = rigSummary({ ...r, fs_name: fs?.name, fs_coin: fs?.coin, fs_algo: fs?.algo,
    open_alerts: get('SELECT COUNT(*) AS n FROM alerts WHERE rig_id = ? AND resolved_at IS NULL', r.id).n }, t);
  const eff = new Map(rigsSvc.effectiveOc(r.id).map((g) => [g.id, g]));
  const gpus = all(`SELECT id, bus_id, idx, vendor, model, vram_mb, driver, vbios, slot, present, oc_profile_id, oc_params, is_new,
                    hashrate, temp, mem_temp, fan, power, core_clk, mem_clk, accepted, rejected, stats_at
                    FROM gpus WHERE rig_id = ? ORDER BY idx`, r.id)
    .map((g) => ({ ...g, present: !!g.present, is_new: !!g.is_new, fresh: summary.online && g.stats_at >= t - ONLINE_SEC,
      oc_params: rigsSvc.parseJson(g.oc_params, null),
      oc_name: eff.get(g.id)?.profile?.name || null, oc_source: eff.get(g.id)?.source || null,
      oc_effective: eff.get(g.id)?.profile ? rigsSvc.parseJson(eff.get(g.id).profile.params, {}) : null }));
  // Rig'deki her kart modeli ve ona atanmış OC profili (rig ayarlarında model başına seçilir)
  const assigned = new Map(all('SELECT model, oc_profile_id FROM rig_oc WHERE rig_id = ?', r.id).map((x) => [x.model, x.oc_profile_id]));
  const models = all(`SELECT model, vendor, COUNT(*) AS count FROM gpus WHERE rig_id = ? AND present = 1
                      GROUP BY model, vendor ORDER BY vendor, model`, r.id)
    .map((m) => ({ ...m, oc_profile_id: assigned.get(m.model) ?? null }));
  const commands = all(`SELECT id, type, status, created_at, finished_at, exit_code, result, CASE WHEN json_valid(payload) THEN json_extract(payload, '$.cmd') END AS cmd FROM commands
                        WHERE rig_id = ? ORDER BY id DESC LIMIT 15`, r.id);
  const alerts = all(`SELECT id, type, severity, message, started_at, resolved_at FROM alerts
                      WHERE rig_id = ? ORDER BY resolved_at IS NOT NULL, started_at DESC LIMIT 20`, r.id);
  res.json({
    rig: { ...summary, hostname: r.hostname, os_info: r.os_info, cpu_model: r.cpu_model, ram_total_mb: r.ram_total_mb,
      ram_used_mb: r.ram_used_mb, cpu_load: r.cpu_load, miner_uptime_sec: r.miner_uptime_sec, paired_at: r.paired_at,
      flight_sheet_id: r.flight_sheet_id, config_version: r.config_version, hw_changed_at: r.hw_changed_at,
      miner_error: summary.online ? r.miner_error : null, tune: rigsSvc.parseJson(r.tune_state, null), has_conf: !!r.secret_enc },
    gpus, models, commands, alerts,
  });
});

// Son 24 saat (5 dk'lık kovalar). Rig toplamı + kart başına.
router.get('/rigs/:id/history', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 24));
  const from = now() - hours * 3600;
  const rig = all('SELECT bucket, hashrate, power, temp_max FROM rig_stats_5m WHERE rig_id = ? AND bucket >= ? ORDER BY bucket', r.id, from);
  const gpuRows = all(`SELECT s.gpu_id, s.bucket, s.hashrate, s.temp, s.fan, s.power FROM gpu_stats_5m s
                       JOIN gpus g ON g.id = s.gpu_id WHERE g.rig_id = ? AND s.bucket >= ? ORDER BY s.bucket`, r.id, from);
  const gpus = {};
  for (const row of gpuRows) (gpus[row.gpu_id] ||= []).push([row.bucket, row.hashrate, row.temp, row.fan, row.power]);
  res.json({ rig: rig.map((x) => [x.bucket, x.hashrate, x.power, x.temp_max]), gpus });
});

router.put('/rigs/:id', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  const b = req.body;
  const name = b.name !== undefined ? str(b.name, 40) : r.name;
  if (!name) return bad(res, 'Rig adı boş olamaz.');
  const fsId = b.flight_sheet_id !== undefined ? idOrNull(b.flight_sheet_id) : r.flight_sheet_id;
  if (fsId !== null && !get('SELECT 1 FROM flight_sheets WHERE id = ? AND user_id = ?', fsId, req.user.id)) return bad(res, 'Flight sheet bulunamadı.');

  // Model başına OC: { "NVIDIA P106-100": 3, "AMD Radeon RX 580 8GB": null }
  const ocModels = [];
  if (b.oc_models && typeof b.oc_models === 'object') {
    for (const [model, value] of Object.entries(b.oc_models).slice(0, 32)) {
      const g = get('SELECT vendor FROM gpus WHERE rig_id = ? AND model = ? LIMIT 1', r.id, String(model));
      if (!g) return bad(res, `Bu rig'de "${model}" kartı yok.`);
      const oc = idOrNull(value);
      if (oc !== null) {
        const p = get('SELECT vendor FROM oc_profiles WHERE id = ? AND user_id = ?', oc, req.user.id);
        if (!p || p.vendor !== g.vendor) return bad(res, `${model} için uygun bir OC profili seçin.`);
      }
      ocModels.push([String(model), oc]);
    }
  }
  tx(() => {
    run('UPDATE rigs SET name=?, flight_sheet_id=?, config_version = config_version + 1 WHERE id=?', name, fsId, r.id);
    for (const [model, oc] of ocModels) {
      if (oc === null) run('DELETE FROM rig_oc WHERE rig_id = ? AND model = ?', r.id, model);
      else run('INSERT OR REPLACE INTO rig_oc (rig_id, model, oc_profile_id) VALUES (?,?,?)', r.id, model, oc);
      run('UPDATE gpus SET is_new = 0 WHERE rig_id = ? AND model = ?', r.id, model); // kullanıcı bu modele baktı
    }
  });
  res.json({ ok: true });
});

// Artık takılı olmayan kartları listeden ve geçmişten sil (istatistikler ON DELETE CASCADE ile gider)
router.delete('/rigs/:id/lost-gpus', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  const n = run('DELETE FROM gpus WHERE rig_id = ? AND present = 0', r.id).changes;
  if (n) run('UPDATE rigs SET config_version = config_version + 1 WHERE id = ?', r.id);
  res.json({ ok: true, deleted: Number(n) });
});

router.put('/rigs/:id/gpus/:gpuId', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  const g = get('SELECT id, vendor, oc_profile_id, oc_params FROM gpus WHERE id = ? AND rig_id = ?', Number(req.params.gpuId), r.id);
  if (!g) return bad(res, 'Kart bulunamadı.', 404);
  const b = req.body || {};
  let oc = g.oc_profile_id;
  if ('oc_profile_id' in b) {
    oc = idOrNull(b.oc_profile_id);
    if (oc !== null) {
      const p = get('SELECT vendor FROM oc_profiles WHERE id = ? AND user_id = ?', oc, req.user.id);
      if (!p || p.vendor !== g.vendor) return bad(res, 'Bu karta uygun bir OC profili seçin.');
    }
  }
  // oc_params: bu karta özel değerler (null = kaldır, profil/model ayarına dön)
  let params = g.oc_params;
  if ('oc_params' in b) {
    if (b.oc_params === null) params = null;
    else {
      const [clean, err] = rigsSvc.cleanOcParams(g.vendor, b.oc_params);
      if (!clean) return bad(res, err);
      params = JSON.stringify(clean);
    }
  }
  tx(() => {
    run('UPDATE gpus SET oc_profile_id = ?, oc_params = ?, is_new = 0 WHERE id = ?', oc, params, g.id);
    rigsSvc.bumpConfig(r.id);
  });
  res.json({ ok: true });
});

router.delete('/rigs/:id', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  run('DELETE FROM rigs WHERE id = ?', r.id); // agent'ın anahtarı geçersiz olur, yeniden kayıt olup eşleşmesi gerekir
  res.json({ ok: true });
});

router.post('/rigs/:id/commands', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  const type = String(req.body.type || '');
  if (!COMMAND_TYPES.has(type) || type.startsWith('oc_tune') || type === 'console') return bad(res, 'Geçersiz komut.'); // bunların kendi uç noktası var
  const dup = get(`SELECT id FROM commands WHERE rig_id = ? AND type = ? AND status IN ('queued','sent')`, r.id, type);
  if (dup) return bad(res, 'Bu komut zaten sırada bekliyor.', 409);
  const c = run('INSERT INTO commands (rig_id, type, payload, created_by, created_at) VALUES (?,?,?,?,?)',
    r.id, type, '{}', req.user.id, now());
  res.json({ ok: true, id: Number(c.lastInsertRowid) });
});

// Rig ekranından yazılan komut (izinli listeden). Sonuç GET /rigs/:id/commands/:cid ile alınır.
router.post('/rigs/:id/console', sec.rateLimit({ windowSec: 60, max: 30, key: (req) => `console:${req.user.id}` }), (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  const line = str(req.body.line, 60).toLowerCase().replace(/\s+/g, ' ').replace(/^(wm|sudo) /, '');
  const cmd = line === 'reboot' ? 'sreboot' : line === 'miner' ? 'miner log' : line;
  if (!CONSOLE_COMMANDS.includes(cmd)) return bad(res, `Bu komut yok: "${line}". Liste için: yardim`);
  if (!r.last_seen_at || r.last_seen_at < now() - ONLINE_SEC) return bad(res, 'Rig çevrimdışı.');
  const c = run('INSERT INTO commands (rig_id, type, payload, created_by, created_at) VALUES (?,?,?,?,?)',
    r.id, 'console', JSON.stringify({ cmd }), req.user.id, now());
  res.json({ ok: true, id: Number(c.lastInsertRowid), cmd });
});

router.get('/rigs/:id/commands/:cid', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  const c = get('SELECT id, type, status, result FROM commands WHERE id = ? AND rig_id = ?', Number(req.params.cid), r.id);
  if (!c) return bad(res, 'Komut bulunamadı.', 404);
  res.set('Cache-Control', 'no-store');
  res.json(c);
});

// ---------- Otomatik OC ----------
// Agent seçilen modeldeki kartlarda adım adım bellek/güç/voltaj dener; en verimli kararlı değeri profil olarak kaydeder.
router.post('/rigs/:id/oc-tune', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  if (!r.last_seen_at || r.last_seen_at < now() - ONLINE_SEC) return bad(res, 'Rig çevrimdışı.');
  if (r.miner_status !== 'running') return bad(res, 'Önce miner çalışıyor olmalı: ölçüm hashrate üzerinden yapılır.');
  const fs = r.flight_sheet_id ? get('SELECT algo FROM flight_sheets WHERE id = ?', r.flight_sheet_id) : null;
  if (!fs) return bad(res, "Rig'e flight sheet atanmamış.");
  const model = str(req.body.model, 80);
  const g = get('SELECT vendor, COUNT(*) AS n FROM gpus WHERE rig_id = ? AND model = ? AND present = 1', r.id, model);
  if (!g || !g.n) return bad(res, `Bu rig'de "${model}" kartı yok.`);
  if (get(`SELECT 1 FROM commands WHERE rig_id = ? AND type = 'oc_tune' AND status IN ('queued','sent')`, r.id)) {
    return bad(res, "Bu rig'de zaten bir otomatik OC çalışıyor.", 409);
  }
  const user = get('SELECT temp_limit FROM users WHERE id = ?', req.user.id);
  // Her kart kendi mevcut değerlerinden başlar ve kendi en iyi değerini bulur
  const startByBus = {};
  for (const x of rigsSvc.effectiveOc(r.id)) {
    if (x.model === model && x.present) startByBus[x.bus_id] = x.profile ? rigsSvc.parseJson(x.profile.params, {}) : null;
  }
  const payload = {
    model, vendor: g.vendor, algo: fs.algo, temp_limit: user.temp_limit, bounds: rigsSvc.OC_FIELDS[g.vendor],
    per_card: true, start_by_bus: startByBus,
  };
  const c = run('INSERT INTO commands (rig_id, type, payload, created_by, created_at) VALUES (?,?,?,?,?)',
    r.id, 'oc_tune', JSON.stringify(payload), req.user.id, now());
  run('UPDATE rigs SET tune_state = ? WHERE id = ?', JSON.stringify({ status: 'queued', model, algo: fs.algo, cards: g.n, updated_at: now() }), r.id);
  res.json({ ok: true, id: Number(c.lastInsertRowid) });
});

router.post('/rigs/:id/oc-tune/cancel', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  tx(() => {
    // Henüz rig'e gitmediyse doğrudan iptal; gittiyse agent'a durdurma komutu
    run(`UPDATE commands SET status = 'failed', result = 'Kullanıcı iptal etti', finished_at = ? WHERE rig_id = ? AND type = 'oc_tune' AND status = 'queued'`, now(), r.id);
    // Rig çevrimdışıysa ya da otomatik OC 5 dk'dır haber vermiyorsa (rig yeniden başlamış) agent'ı bekleme: kayıt hemen kapansın
    const prevTune = rigsSvc.parseJson(r.tune_state, {}) || {};
    const gone = !r.last_seen_at || r.last_seen_at < now() - ONLINE_SEC || (prevTune.updated_at || 0) < now() - 300;
    if (gone) {
      run(`UPDATE commands SET status = 'failed', result = 'Rig yanıt vermedi, iptal edildi', finished_at = ? WHERE rig_id = ? AND type IN ('oc_tune','oc_tune_cancel') AND status IN ('queued','sent')`, now(), r.id);
    }
    if (!gone && get(`SELECT 1 FROM commands WHERE rig_id = ? AND type = 'oc_tune' AND status = 'sent'`, r.id)) {
      run('INSERT INTO commands (rig_id, type, payload, created_by, created_at) VALUES (?,?,?,?,?)', r.id, 'oc_tune_cancel', '{}', req.user.id, now());
    } else {
      const prev = rigsSvc.parseJson(r.tune_state, {}) || {};
      run('UPDATE rigs SET tune_state = ? WHERE id = ?', JSON.stringify({ ...prev, status: 'cancelled', updated_at: now() }), r.id);
    }
  });
  res.json({ ok: true });
});

// Otomatik OC sonucu: her karta kendi bulunan değerini yaz
router.post('/rigs/:id/oc-tune/apply', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  const t = rigsSvc.parseJson(r.tune_state, null);
  const cards = t && t.status === 'done' && t.result && Array.isArray(t.result.cards) ? t.result.cards : null;
  if (!cards) return bad(res, 'Uygulanacak otomatik OC sonucu yok.');
  let n = 0;
  tx(() => {
    for (const c of cards) {
      const g = get('SELECT id, vendor FROM gpus WHERE rig_id = ? AND bus_id = ? AND present = 1', r.id, String(c.bus_id));
      if (!g || !c.params) continue;
      const [clean] = rigsSvc.cleanOcParams(g.vendor, c.params, { clamp: true });
      if (!clean) continue;
      run('UPDATE gpus SET oc_params = ?, is_new = 0 WHERE id = ?', JSON.stringify(clean), g.id);
      n++;
    }
    rigsSvc.bumpConfig(r.id);
    run('UPDATE rigs SET tune_state = NULL WHERE id = ?', r.id);
  });
  res.json({ ok: true, applied: n });
});

router.post('/rigs/:id/oc-tune/dismiss', (req, res) => {
  const r = rigsSvc.ownedRig(req.user.id, req.params.id);
  if (!r) return bad(res, 'Rig bulunamadı.', 404);
  run(`UPDATE rigs SET tune_state = NULL WHERE id = ? AND (tune_state IS NULL OR json_extract(tune_state, '$.status') IN ('done','failed','cancelled'))`, r.id);
  res.json({ ok: true });
});

// ---------- Cüzdanlar ----------
router.get('/wallets', (req, res) => {
  res.json({ wallets: all('SELECT id, coin, name, address FROM wallets WHERE user_id = ? ORDER BY coin, name', req.user.id) });
});

function walletInput(b) {
  const w = { coin: str(b.coin, 12).toUpperCase(), name: str(b.name, 40), address: str(b.address, 200) };
  if (!w.coin || !w.name) return [null, 'Coin ve ad zorunlu.'];
  if (!/^[A-Za-z0-9:._-]{10,200}$/.test(w.address)) return [null, 'Cüzdan adresi geçersiz görünüyor.'];
  return [w];
}

router.post('/wallets', (req, res) => {
  const [w, err] = walletInput(req.body);
  if (!w) return bad(res, err);
  const r = run('INSERT INTO wallets (user_id, coin, name, address, created_at) VALUES (?,?,?,?,?)', req.user.id, w.coin, w.name, w.address, now());
  // Bilinen coin'se havuzu ve miner'ı seçilmiş flight sheet kendiliğinden hazırlanır ("Oto · COIN")
  const created = autoswitch.ensureSheets(req.user.id);
  res.json({ ok: true, id: Number(r.lastInsertRowid), flight_sheets_created: created });
});

router.put('/wallets/:id', (req, res) => {
  const [w, err] = walletInput(req.body);
  if (!w) return bad(res, err);
  const id = Number(req.params.id);
  const r = run('UPDATE wallets SET coin=?, name=?, address=? WHERE id=? AND user_id=?', w.coin, w.name, w.address, id, req.user.id);
  if (!r.changes) return bad(res, 'Cüzdan bulunamadı.', 404);
  rigsSvc.bumpConfigForWallet(id);
  res.json({ ok: true });
});

router.delete('/wallets/:id', (req, res) => {
  const id = Number(req.params.id);
  if (get('SELECT 1 FROM flight_sheets WHERE wallet_id = ? AND user_id = ?', id, req.user.id)) {
    return bad(res, 'Bu cüzdan bir flight sheet\'te kullanılıyor.', 409);
  }
  run('DELETE FROM wallets WHERE id = ? AND user_id = ?', id, req.user.id);
  res.json({ ok: true });
});

// ---------- Miner kataloğu ----------
router.get('/miners', (_req, res) => {
  const miners = all('SELECT * FROM miners ORDER BY name');
  const versions = all('SELECT id, miner_id, version, download_url, sha256, algos, is_default, created_at FROM miner_versions ORDER BY created_at DESC');
  res.json({
    miners: miners.map((m) => ({ ...m, supports_nvidia: !!m.supports_nvidia, supports_amd: !!m.supports_amd,
      versions: versions.filter((v) => v.miner_id === m.id).map((v) => ({ ...v, is_default: !!v.is_default })) })),
  });
});

router.post('/miners', sec.requireAdmin, (req, res) => {
  const b = req.body;
  const name = str(b.name, 40);
  const api = str(b.api_type, 30).toLowerCase();
  if (!name || !/^[a-z0-9_-]+$/.test(api)) return bad(res, 'Ad ve API türü zorunlu.');
  if (!b.supports_nvidia && !b.supports_amd) return bad(res, 'En az bir kart türü seçin.');
  try {
    run('INSERT INTO miners (name, api_type, supports_nvidia, supports_amd, notes) VALUES (?,?,?,?,?)',
      name, api, b.supports_nvidia ? 1 : 0, b.supports_amd ? 1 : 0, str(b.notes, 300));
  } catch { return bad(res, 'Bu isimde bir miner zaten var.', 409); }
  res.json({ ok: true });
});

router.post('/miners/:id/versions', sec.requireAdmin, (req, res) => {
  const b = req.body;
  const minerId = Number(req.params.id);
  if (!get('SELECT 1 FROM miners WHERE id = ?', minerId)) return bad(res, 'Miner bulunamadı.', 404);
  const version = str(b.version, 30);
  const url = str(b.download_url, 500);
  const sha = str(b.sha256, 64).toLowerCase();
  if (!version) return bad(res, 'Sürüm zorunlu.');
  if (!/^https:\/\//.test(url)) return bad(res, 'İndirme adresi https:// ile başlamalı.');
  if (sha && !/^[0-9a-f]{64}$/.test(sha)) return bad(res, 'SHA256 64 karakterlik hex olmalı.');
  try {
    tx(() => {
      if (b.is_default) run('UPDATE miner_versions SET is_default = 0 WHERE miner_id = ?', minerId);
      run(`INSERT INTO miner_versions (miner_id, version, download_url, sha256, algos, is_default, created_at) VALUES (?,?,?,?,?,?,?)`,
        minerId, version, url, sha, str(b.algos, 300).toLowerCase().replace(/\s+/g, ''), b.is_default ? 1 : 0, now());
    });
  } catch { return bad(res, 'Bu sürüm zaten kayıtlı.', 409); }
  res.json({ ok: true });
});

router.put('/miner-versions/:id', sec.requireAdmin, (req, res) => {
  const v = get('SELECT * FROM miner_versions WHERE id = ?', Number(req.params.id));
  if (!v) return bad(res, 'Sürüm bulunamadı.', 404);
  const b = req.body;
  const url = b.download_url !== undefined ? str(b.download_url, 500) : v.download_url;
  const sha = b.sha256 !== undefined ? str(b.sha256, 64).toLowerCase() : v.sha256;
  if (!/^https:\/\//.test(url)) return bad(res, 'İndirme adresi https:// ile başlamalı.');
  if (sha && !/^[0-9a-f]{64}$/.test(sha)) return bad(res, 'SHA256 64 karakterlik hex olmalı.');
  tx(() => {
    if (b.is_default) run('UPDATE miner_versions SET is_default = 0 WHERE miner_id = ?', v.miner_id);
    run('UPDATE miner_versions SET download_url=?, sha256=?, algos=?, is_default=? WHERE id=?', url, sha,
      b.algos !== undefined ? str(b.algos, 300).toLowerCase().replace(/\s+/g, '') : v.algos,
      b.is_default !== undefined ? (b.is_default ? 1 : 0) : v.is_default, v.id);
    run(`UPDATE rigs SET config_version = config_version + 1 WHERE flight_sheet_id IN
         (SELECT flight_sheet_id FROM flight_sheet_miners WHERE miner_version_id = ?)`, v.id);
  });
  res.json({ ok: true });
});

router.delete('/miner-versions/:id', sec.requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (get('SELECT 1 FROM flight_sheet_miners WHERE miner_version_id = ?', id)) return bad(res, 'Bu sürüm bir flight sheet\'te kullanılıyor.', 409);
  run('DELETE FROM miner_versions WHERE id = ?', id);
  res.json({ ok: true });
});

// ---------- Agent sürümleri ----------
router.get('/agent-releases', sec.requireAdmin, (_req, res) => {
  res.json({ releases: all('SELECT * FROM agent_releases ORDER BY created_at DESC') });
});
router.post('/agent-releases', sec.requireAdmin, (req, res) => {
  const b = req.body;
  const version = str(b.version, 30);
  const url = str(b.download_url, 500);
  const sha = str(b.sha256, 64).toLowerCase();
  if (!/^\d+(\.\d+){1,3}$/.test(version)) return bad(res, 'Sürüm 1.2.3 biçiminde olmalı.');
  if (!/^https:\/\//.test(url)) return bad(res, 'İndirme adresi https:// ile başlamalı.');
  if (!/^[0-9a-f]{64}$/.test(sha)) return bad(res, 'SHA256 zorunlu (64 karakter hex).');
  try {
    run('INSERT INTO agent_releases (version, channel, download_url, sha256, notes, created_at) VALUES (?,?,?,?,?,?)',
      version, b.channel === 'beta' ? 'beta' : 'stable', url, sha, str(b.notes, 1000), now());
  } catch { return bad(res, 'Bu sürüm zaten kayıtlı.', 409); }
  res.json({ ok: true });
});
router.delete('/agent-releases/:id', sec.requireAdmin, (req, res) => {
  run('DELETE FROM agent_releases WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Flash imajları ----------
router.get('/os-images', (_req, res) => {
  res.json({ images: all('SELECT * FROM os_images ORDER BY created_at DESC LIMIT 20') });
});
router.post('/os-images', sec.requireAdmin, (req, res) => {
  const b = req.body;
  const version = str(b.version, 30);
  const url = str(b.download_url, 500);
  const sha = str(b.sha256, 64).toLowerCase();
  const size = b.size_mb === '' || b.size_mb === undefined ? null : Math.round(Number(b.size_mb));
  if (!/^\d+(\.\d+){1,3}$/.test(version)) return bad(res, 'Sürüm 1.0.0 biçiminde olmalı.');
  if (!/^https:\/\//.test(url)) return bad(res, 'İndirme adresi https:// ile başlamalı.');
  if (!/^[0-9a-f]{64}$/.test(sha)) return bad(res, 'SHA256 zorunlu (64 karakter hex).');
  if (size !== null && !(size > 0 && size < 100000)) return bad(res, 'Boyut MB olarak girilmeli.');
  try {
    run('INSERT INTO os_images (version, download_url, sha256, size_mb, notes, created_at) VALUES (?,?,?,?,?,?)',
      version, url, sha, size, str(b.notes, 1000), now());
  } catch { return bad(res, 'Bu sürüm zaten kayıtlı.', 409); }
  res.json({ ok: true });
});
router.delete('/os-images/:id', sec.requireAdmin, (req, res) => {
  run('DELETE FROM os_images WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Flight sheet'ler ----------
router.get('/flight-sheets', (req, res) => {
  const sheets = all(`SELECT f.*, w.name AS wallet_name, w.address AS wallet_address,
                      (SELECT COUNT(*) FROM rigs r WHERE r.flight_sheet_id = f.id) AS rig_count
                      FROM flight_sheets f LEFT JOIN wallets w ON w.id = f.wallet_id
                      WHERE f.user_id = ? ORDER BY f.name COLLATE NOCASE`, req.user.id);
  res.json({
    flight_sheets: sheets.map((f) => ({ ...f, pools: rigsSvc.parseJson(f.pools, []),
      miners: rigsSvc.flightSheetMiners(f.id).map((m) => ({ miner_version_id: m.miner_version_id, name: m.name,
        version: m.version, gpu_vendor: m.gpu_vendor, extra_args: m.extra_args, sha256_ok: !!m.sha256 })) })),
  });
});

function flightSheetInput(req) {
  const b = req.body;
  const f = {
    name: str(b.name, 60), coin: str(b.coin, 12).toUpperCase(), algo: str(b.algo, 30).toLowerCase(),
    wallet_id: idOrNull(b.wallet_id), worker_template: str(b.worker_template || '%RIG_NAME%', 40),
    pool_pass: str(b.pool_pass || 'x', 60),
    pools: (Array.isArray(b.pools) ? b.pools : String(b.pools || '').split(/\s+/)).map((p) => str(p, 200)).filter(Boolean).slice(0, 5),
    miners: Array.isArray(b.miners) ? b.miners.slice(0, 3) : [],
  };
  if (!f.name || !f.coin || !f.algo) return [null, 'Ad, coin ve algoritma zorunlu.'];
  if (!f.pools.length) return [null, 'En az bir havuz adresi girin.'];
  if (f.pools.some((p) => !/^(stratum\+(tcp|ssl|tls)|stratum2?|ssl|tcp):\/\/[^\s]+:\d+$/.test(p))) {
    return [null, 'Havuz adresi stratum+tcp://adres:port biçiminde olmalı.'];
  }
  if (f.wallet_id !== null && !get('SELECT 1 FROM wallets WHERE id = ? AND user_id = ?', f.wallet_id, req.user.id)) return [null, 'Cüzdan bulunamadı.'];
  if (!f.wallet_id) return [null, 'Cüzdan seçin.'];
  if (!f.miners.length) return [null, 'En az bir miner seçin.'];
  const vendors = new Set();
  for (const m of f.miners) {
    const mv = get(`SELECT mv.id, mv.algos, m.name, m.supports_nvidia, m.supports_amd FROM miner_versions mv
                    JOIN miners m ON m.id = mv.miner_id WHERE mv.id = ?`, Number(m.miner_version_id));
    if (!mv) return [null, 'Seçilen miner sürümü bulunamadı.'];
    m.gpu_vendor = ['all', 'nvidia', 'amd'].includes(m.gpu_vendor) ? m.gpu_vendor : 'all';
    if ((m.gpu_vendor === 'nvidia' && !mv.supports_nvidia) || (m.gpu_vendor === 'amd' && !mv.supports_amd)) {
      return [null, `${mv.name} bu kart türünü desteklemiyor.`];
    }
    if (m.gpu_vendor === 'all' && !(mv.supports_nvidia && mv.supports_amd)) {
      m.gpu_vendor = mv.supports_nvidia ? 'nvidia' : 'amd'; // tek tür destekliyorsa ona sabitle
    }
    if (mv.algos && !mv.algos.split(',').includes(f.algo)) return [null, `${mv.name} ${f.algo} algoritmasını desteklemiyor.`];
    for (const v of (m.gpu_vendor === 'all' ? ['nvidia', 'amd'] : [m.gpu_vendor])) {
      if (vendors.has(v)) return [null, 'Aynı kart türüne iki miner atanamaz.'];
      vendors.add(v);
    }
    m.extra_args = str(m.extra_args, 300);
  }
  return [f];
}

function saveFlightSheetMiners(fsId, miners) {
  run('DELETE FROM flight_sheet_miners WHERE flight_sheet_id = ?', fsId);
  for (const m of miners) {
    run('INSERT INTO flight_sheet_miners (flight_sheet_id, miner_version_id, gpu_vendor, extra_args) VALUES (?,?,?,?)',
      fsId, Number(m.miner_version_id), m.gpu_vendor, m.extra_args);
  }
}

router.post('/flight-sheets', (req, res) => {
  const [f, err] = flightSheetInput(req);
  if (!f) return bad(res, err);
  const id = tx(() => {
    const r = run(`INSERT INTO flight_sheets (user_id, name, coin, algo, wallet_id, pools, worker_template, pool_pass, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)`, req.user.id, f.name, f.coin, f.algo, f.wallet_id, JSON.stringify(f.pools),
    f.worker_template, f.pool_pass, now(), now());
    saveFlightSheetMiners(Number(r.lastInsertRowid), f.miners);
    return Number(r.lastInsertRowid);
  });
  res.json({ ok: true, id });
});

router.put('/flight-sheets/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT 1 FROM flight_sheets WHERE id = ? AND user_id = ?', id, req.user.id)) return bad(res, 'Flight sheet bulunamadı.', 404);
  const [f, err] = flightSheetInput(req);
  if (!f) return bad(res, err);
  tx(() => {
    run(`UPDATE flight_sheets SET name=?, coin=?, algo=?, wallet_id=?, pools=?, worker_template=?, pool_pass=?, updated_at=? WHERE id=?`,
      f.name, f.coin, f.algo, f.wallet_id, JSON.stringify(f.pools), f.worker_template, f.pool_pass, now(), id);
    saveFlightSheetMiners(id, f.miners);
    rigsSvc.bumpConfigForFlightSheet(id);
  });
  res.json({ ok: true });
});

router.delete('/flight-sheets/:id', (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    if (!get('SELECT 1 FROM flight_sheets WHERE id = ? AND user_id = ?', id, req.user.id)) return;
    rigsSvc.bumpConfigForFlightSheet(id);
    run('DELETE FROM flight_sheets WHERE id = ?', id);
  });
  res.json({ ok: true });
});

// Toplu atama: bir flight sheet'i birden çok rig'e uygula
router.post('/flight-sheets/:id/apply', (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT 1 FROM flight_sheets WHERE id = ? AND user_id = ?', id, req.user.id)) return bad(res, 'Flight sheet bulunamadı.', 404);
  const rigIds = Array.isArray(req.body.rig_ids) ? req.body.rig_ids.map(String).slice(0, 200) : [];
  let n = 0;
  tx(() => {
    for (const rid of rigIds) {
      n += Number(run('UPDATE rigs SET flight_sheet_id = ?, config_version = config_version + 1 WHERE id = ? AND owner_id = ?', id, rid, req.user.id).changes);
    }
  });
  res.json({ ok: true, applied: n });
});

// ---------- OC profilleri ----------
const { OC_FIELDS } = rigsSvc;

function ocInput(b) {
  const vendor = b.vendor === 'amd' ? 'amd' : b.vendor === 'nvidia' ? 'nvidia' : null;
  const name = str(b.name, 40);
  if (!vendor || !name) return [null, 'Ad ve kart türü zorunlu.'];
  const params = {};
  for (const [k, [min, max]] of Object.entries(OC_FIELDS[vendor])) {
    const v = b.params?.[k];
    if (v === undefined || v === null || v === '') continue; // boş = dokunma
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < min || n > max) return [null, `${k} değeri ${min} ile ${max} arasında olmalı.`];
    params[k] = n;
  }
  return [{ vendor, name, params }];
}

router.get('/oc-profiles', (req, res) => {
  // Kullanım: bu profilin uygulandığı kart sayısı (karta özel + model ataması)
  const rows = all(`SELECT o.*, (SELECT COUNT(*) FROM gpus g LEFT JOIN rig_oc ro ON ro.rig_id = g.rig_id AND ro.model = g.model
                     WHERE g.present = 1 AND COALESCE(g.oc_profile_id, ro.oc_profile_id) = o.id) AS usage
                    FROM oc_profiles o WHERE o.user_id = ? ORDER BY o.vendor, o.name COLLATE NOCASE`, req.user.id);
  res.json({ oc_profiles: rows.map((o) => ({ ...o, params: rigsSvc.parseJson(o.params, {}) })), fields: OC_FIELDS });
});

router.post('/oc-profiles', (req, res) => {
  const [o, err] = ocInput(req.body);
  if (!o) return bad(res, err);
  const r = run('INSERT INTO oc_profiles (user_id, name, vendor, params, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    req.user.id, o.name, o.vendor, JSON.stringify(o.params), now(), now());
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

router.put('/oc-profiles/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = get('SELECT vendor FROM oc_profiles WHERE id = ? AND user_id = ?', id, req.user.id);
  if (!existing) return bad(res, 'Profil bulunamadı.', 404);
  const [o, err] = ocInput({ ...req.body, vendor: existing.vendor }); // tür değiştirilemez
  if (!o) return bad(res, err);
  tx(() => {
    run('UPDATE oc_profiles SET name=?, params=?, updated_at=? WHERE id=?', o.name, JSON.stringify(o.params), now(), id);
    rigsSvc.bumpConfigForOcProfile(id);
  });
  res.json({ ok: true });
});

router.delete('/oc-profiles/:id', (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    if (!get('SELECT 1 FROM oc_profiles WHERE id = ? AND user_id = ?', id, req.user.id)) return;
    rigsSvc.bumpConfigForOcProfile(id);
    run('DELETE FROM oc_profiles WHERE id = ?', id);
  });
  res.json({ ok: true });
});

// ---------- Uyarılar ----------
router.get('/alerts', (req, res) => {
  const which = req.query.status === 'resolved' ? 'IS NOT NULL' : 'IS NULL';
  const rows = all(`SELECT a.id, a.rig_id, r.name AS rig_name, a.gpu_id, a.type, a.severity, a.message, a.started_at, a.resolved_at, a.notified_at
                    FROM alerts a JOIN rigs r ON r.id = a.rig_id
                    WHERE r.owner_id = ? AND a.resolved_at ${which} ORDER BY a.started_at DESC LIMIT 200`, req.user.id);
  res.json({ alerts: rows });
});

module.exports = { router };
