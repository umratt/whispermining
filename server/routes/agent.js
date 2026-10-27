'use strict';
const express = require('express');
const crypto = require('crypto');
const { get, all, run, tx, now } = require('../db');
const config = require('../config');
const sec = require('../security');
const rigsSvc = require('../services/rigs');
const { buildAgentConfig } = rigsSvc;
const { ingestStats } = require('../services/stats');

const router = express.Router();
router.use(express.json({ limit: '256kb' })); // 14 kartlı rig: kart verisi + otomatik OC geçmişi + ekran

const str = (v, max = 200) => (v === undefined || v === null ? null : String(v).slice(0, max));
const COMMAND_TYPES = new Set(['miner_start', 'miner_stop', 'miner_restart', 'reboot', 'apply_oc', 'oc_tune', 'oc_tune_cancel', 'console']);
// Panelden rig'e yazılabilen komutlar (rig ekranı). Serbest kabuk komutu yok: agent sadece bu listeyi tanır.
const CONSOLE_COMMANDS = ['miner start', 'miner stop', 'miner restart', 'miner log', 'miner api', 'oc', 'sreboot', 'nvidia-smi', 'clinfo',
  'uptime', 'df', 'free', 'ip', 'ping', 'lspci', 'dmesg', 'log', 'bilgi', 'guncelle'];
// Otomatik OC uzun sürer: rig'e gönderildikten sonra bu kadar süre sonuç beklenir
const LONG_COMMANDS = { oc_tune: 4 * 3600 };
const SCREEN_POLL_SEC = 3; // panelde ekran izlenirken agent'ın bağlanma aralığı
// Otomatik OC durumu: kart başına denenen değer geçmişiyle büyür (14 kartta ~30 KB)
const TUNE_MAX = 100000;
// JSON ortadan kesilirse okunamaz: sığmazsa önce geçmiş listeleri kısaltılır
function tuneJson(state) {
  let json = JSON.stringify(state);
  if (json.length <= TUNE_MAX) return json;
  const trim = (cards) => (Array.isArray(cards) ? cards.map((c) => ({ ...c, history: (c.history || []).slice(-3) })) : cards);
  json = JSON.stringify({ ...state, card_list: trim(state.card_list), result: state.result && { ...state.result, cards: trim(state.result.cards) } });
  return json.length <= TUNE_MAX ? json : JSON.stringify({ status: state.status, model: state.model, message: state.message, updated_at: state.updated_at });
}

function newPairingCode() {
  for (let i = 0; i < 10; i++) {
    const code = sec.generatePairingCode();
    if (!get('SELECT 1 FROM rigs WHERE pairing_code = ?', code)) return code;
  }
  throw new Error('pairing code collision');
}

// Rig doğrulaması: Authorization: Bearer <rig_id>.<secret>
function authRig(req, res, next) {
  const m = String(req.get('authorization') || '').match(/^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,128})$/);
  const rig = m && get('SELECT * FROM rigs WHERE id = ?', m[1]);
  if (!rig || !sec.safeEqualHex(rig.secret_hash, sec.sha256(m[2]))) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  run('UPDATE rigs SET last_seen_at = ?, last_ip = ? WHERE id = ?', now(), req.ip, rig.id);
  req.rig = rig;
  next();
}

function requirePaired(req, res, next) {
  if (!req.rig.owner_id) return res.status(403).json({ error: 'not_paired' });
  next();
}

// Agent her yanıttan "ayar değişti mi / komut var mı" bilgisini öğrenir
function syncHints(rig) {
  const pending = get(`SELECT COUNT(*) AS n FROM commands WHERE rig_id = ? AND status = 'queued'`, rig.id).n;
  // Panelde biri rig ekranını izliyorsa agent ekranı gönderir ve daha sık bağlanır
  const watching = (rig.screen_watch_until || 0) > now();
  return { config_version: rig.config_version, pending_commands: pending, server_time: now(),
    poll_interval_sec: watching ? SCREEN_POLL_SEC : config.agentPollSec, want_screen: watching };
}

// 1) Kayıt
router.post('/register', sec.rateLimit({ windowSec: 3600, max: 20 }), (req, res) => {
  const b = req.body || {};
  const fingerprint = str(b.hw_fingerprint, 128);
  if (!fingerprint || fingerprint.length < 8) return res.status(400).json({ error: 'hw_fingerprint_required' });

  const rigId = crypto.randomUUID();
  const secret = sec.randomToken(32);
  const code = newPairingCode();
  const t = now();
  tx(() => {
    // Aynı donanımdan eşleşmemiş eski kayıt varsa sil (flash yeniden yazıldıysa çöp birikmesin)
    run('DELETE FROM rigs WHERE hw_fingerprint = ? AND owner_id IS NULL', fingerprint);
    run(`INSERT INTO rigs (id, name, secret_hash, pairing_code, pairing_expires_at, hw_fingerprint, hostname,
         agent_version, os_info, last_ip, last_seen_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    rigId, str(b.hostname, 32) || `rig-${rigId.slice(0, 6)}`, sec.sha256(secret), code, t + config.pairingTtlSec,
    fingerprint, str(b.hostname, 64), str(b.agent_version, 32), str(b.os_info, 200), req.ip, t, t);
  });
  res.status(201).json({
    rig_id: rigId,
    rig_secret: secret,
    pairing_code: code,
    pairing_expires_at: t + config.pairingTtlSec,
    poll_interval_sec: config.agentPollSec,
  });
});

router.use(authRig);

// 2) Durum: eşleşti mi? Kod süresi dolduysa yenisini verir.
router.get('/status', (req, res) => {
  let rig = req.rig;
  if (!rig.owner_id && (!rig.pairing_code || rig.pairing_expires_at < now())) {
    run('UPDATE rigs SET pairing_code = ?, pairing_expires_at = ? WHERE id = ?', newPairingCode(), now() + config.pairingTtlSec, rig.id);
    rig = get('SELECT * FROM rigs WHERE id = ?', rig.id);
  }
  // Agent her açılışta bir kez /status çağırır: yarıda kalmış otomatik OC artık rig'de yok, "sürüyor" görünmesin
  const orphan = get(`SELECT id FROM commands WHERE rig_id = ? AND type = 'oc_tune' AND status = 'sent'`, rig.id);
  if (orphan) {
    const msg = "Rig yeniden başladığı için otomatik OC yarıda kaldı. Tekrar başlatabilirsiniz.";
    run('UPDATE commands SET status = ?, exit_code = 1, result = ?, finished_at = ? WHERE id = ?', 'failed', msg, now(), orphan.id);
    const prev = rigsSvc.parseJson(rig.tune_state, {}) || {};
    run('UPDATE rigs SET tune_state = ? WHERE id = ?', tuneJson({ ...prev, status: 'failed', message: msg, updated_at: now() }), rig.id);
  }
  res.json({
    paired: !!rig.owner_id,
    rig_name: rig.name,
    pairing_code: rig.owner_id ? null : rig.pairing_code,
    pairing_expires_at: rig.owner_id ? null : rig.pairing_expires_at,
    ...syncHints(rig),
  });
});

// 3) Donanım bilgisi (eşleşmeden önce de kabul edilir)
router.put('/hardware', (req, res) => {
  const b = req.body || {};
  const list = Array.isArray(b.gpus) ? b.gpus.slice(0, 32) : null;
  if (!list) return res.status(400).json({ error: 'gpus_required' });
  const t = now();
  const seen = new Set();
  let changed = false;
  tx(() => {
    // Donanım kimliği: rig.conf başka bir makineye takılırsa (ya da kopyalanırsa) uyarı için işaretle
    const fp = str(b.hw_fingerprint, 128);
    if (fp && fp !== req.rig.hw_fingerprint) {
      run('UPDATE rigs SET hw_fingerprint = ?, hw_changed_at = ? WHERE id = ?', fp, req.rig.hw_fingerprint ? t : null, req.rig.id);
    }
    run('UPDATE rigs SET cpu_model = ?, ram_total_mb = ?, os_info = COALESCE(?, os_info), agent_version = COALESCE(?, agent_version) WHERE id = ?',
      str(b.cpu_model, 120), Number.isFinite(Number(b.ram_total_mb)) ? Math.round(b.ram_total_mb) : null,
      str(b.os_info, 200), str(b.agent_version, 32), req.rig.id);
    // İlk donanım bildiriminde tüm kartlar zaten yeni; "yeni kart" sadece sonradan takılanlar için
    const hadGpus = get('SELECT COUNT(*) AS n FROM gpus WHERE rig_id = ?', req.rig.id).n > 0;
    list.forEach((g, i) => {
      const busId = str(g.bus_id, 32);
      const vendor = g.vendor === 'amd' ? 'amd' : g.vendor === 'nvidia' ? 'nvidia' : null;
      if (!busId || !vendor || seen.has(busId)) return;
      seen.add(busId);
      const existing = get('SELECT id, present, model FROM gpus WHERE rig_id = ? AND bus_id = ?', req.rig.id, busId);
      const vals = [Number.isInteger(g.index) ? g.index : i, vendor, str(g.model, 80) || 'Bilinmeyen GPU',
        Number.isFinite(Number(g.vram_mb)) ? Math.round(g.vram_mb) : null, str(g.driver, 40), str(g.vbios, 60), str(g.uuid, 80)];
      if (existing) {
        if (!existing.present) changed = true;
        if (existing.model !== vals[2]) { changed = true; run('UPDATE gpus SET is_new = 1, oc_profile_id = NULL WHERE id = ?', existing.id); }
        run('UPDATE gpus SET idx=?, vendor=?, model=?, vram_mb=?, driver=?, vbios=?, uuid=?, present=1, last_seen=? WHERE id=?',
          ...vals, t, existing.id);
      } else {
        changed = true;
        run(`INSERT INTO gpus (rig_id, bus_id, idx, vendor, model, vram_mb, driver, vbios, uuid, present, is_new, first_seen, last_seen)
             VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)`, req.rig.id, busId, ...vals, hadGpus ? 1 : 0, t, t);
      }
    });
    // Listede olmayan kartlar "kayıp" olarak işaretlenir; uyarı motoru bunu yakalar
    for (const g of all('SELECT id, bus_id, present FROM gpus WHERE rig_id = ?', req.rig.id)) {
      if (!seen.has(g.bus_id) && g.present) { run('UPDATE gpus SET present = 0 WHERE id = ?', g.id); changed = true; }
    }
    if (changed) run('UPDATE rigs SET config_version = config_version + 1 WHERE id = ?', req.rig.id); // OC listesi değişti
  });
  const rig = get('SELECT * FROM rigs WHERE id = ?', req.rig.id);
  res.json({ ok: true, gpus: seen.size, ...syncHints(rig) });
});

// 4) Periyodik istatistik
router.post('/stats', requirePaired, (req, res) => {
  const { unknownGpus } = ingestStats(req.rig, req.body || {});
  const screen = (req.body || {}).screen;
  if (screen && typeof screen === 'object') {
    run('UPDATE rigs SET screen_text = ?, screen_log = ?, screen_at = ? WHERE id = ?',
      str(screen.text, 8000), str(screen.log, 16000), now(), req.rig.id);
  }
  const tune = (req.body || {}).tune;
  if (tune && typeof tune === 'object') {
    const prev = rigsSvc.parseJson(req.rig.tune_state, {}) || {};
    const json = JSON.stringify({ ...tune, result_profile_id: prev.result_profile_id, updated_at: now() });
    if (json.length <= TUNE_MAX) run('UPDATE rigs SET tune_state = ? WHERE id = ?', json, req.rig.id); // aşırı büyükse yok say
  }
  res.json({ ok: true, hardware_required: unknownGpus > 0, ...syncHints(req.rig) });
});

// 5) Güncel ayarlar (flight sheet + OC)
router.get('/config', requirePaired, (req, res) => {
  res.json(buildAgentConfig(req.rig));
});

// 6) Bekleyen komutlar
router.get('/commands', requirePaired, (req, res) => {
  const t = now();
  const cmds = tx(() => {
    const rows = all(`SELECT id, type, payload, created_at FROM commands WHERE rig_id = ? AND status = 'queued'
                      AND created_at >= ? ORDER BY id LIMIT 20`, req.rig.id, t - config.commandTtlSec);
    for (const c of rows) run(`UPDATE commands SET status = 'sent', sent_at = ? WHERE id = ?`, t, c.id);
    return rows;
  });
  res.json({ commands: cmds.map((c) => ({ id: c.id, type: c.type, payload: JSON.parse(c.payload), created_at: c.created_at })) });
});

// 7) Komut sonucu
router.post('/commands/:id/result', requirePaired, (req, res) => {
  const b = req.body || {};
  const cmd = get('SELECT id, status, type, payload FROM commands WHERE id = ? AND rig_id = ?', Number(req.params.id), req.rig.id);
  if (!cmd) return res.status(404).json({ error: 'command_not_found' });
  if (!['queued', 'sent'].includes(cmd.status)) return res.status(409).json({ error: 'already_finished' });
  const status = b.status === 'done' ? 'done' : 'failed';
  let output = str(b.output, cmd.type === 'console' ? 12000 : 4000); // nvidia-smi gibi çıktılar uzun olabilir
  if (cmd.type === 'oc_tune' && status === 'done') {
    // Agent sonucu JSON olarak verir: önerilen değerler yeni bir OC profili olarak kaydedilir (atama kullanıcıya kalır)
    const r = rigsSvc.parseJson(String(b.output || '').slice(0, TUNE_MAX), null); // kart kart sonuç 4000 karakteri aşabilir
    // Kart başına sonuç (cards) kartlara uygulanmak üzere saklanır; eski tek-profil biçimi profil olarak kaydedilir
    const ok = !!(r && Array.isArray(r.cards) && r.cards.length);
    const profileId = !ok && r && req.rig.owner_id ? rigsSvc.saveTunedProfile(req.rig.owner_id, r) : null;
    const prev = rigsSvc.parseJson(req.rig.tune_state, {}) || {};
    run('UPDATE rigs SET tune_state = ? WHERE id = ?',
      tuneJson({ ...prev, status: ok || profileId ? 'done' : 'failed', result: r, result_profile_id: profileId, updated_at: now() }), req.rig.id);
    if (r && r.summary) output = str(r.summary, 4000);
  } else if (cmd.type === 'oc_tune') {
    const prev = rigsSvc.parseJson(req.rig.tune_state, {}) || {};
    run('UPDATE rigs SET tune_state = ? WHERE id = ?', tuneJson({ ...prev, status: 'failed', message: output, updated_at: now() }), req.rig.id);
  }
  run('UPDATE commands SET status = ?, exit_code = ?, result = ?, finished_at = ? WHERE id = ?',
    status, Number.isInteger(b.exit_code) ? b.exit_code : null, output, now(), cmd.id);
  res.json({ ok: true });
});

// 8) Agent güncellemesi
router.get('/update', (req, res) => {
  const channel = req.query.channel === 'beta' ? 'beta' : 'stable';
  const current = str(req.query.version, 32) || req.rig.agent_version || '0';
  const latest = all('SELECT version, download_url, sha256, notes FROM agent_releases WHERE channel = ?', channel)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!latest || compareVersions(latest.version, current) <= 0) return res.json({ update_available: false });
  res.json({ update_available: true, version: latest.version, download_url: latest.download_url, sha256: latest.sha256, notes: latest.notes });
});

function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

module.exports = { router, COMMAND_TYPES, CONSOLE_COMMANDS, LONG_COMMANDS, compareVersions };
