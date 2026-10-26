'use strict';
const { get, all, run, now } = require('../db');
const config = require('../config');
const notify = require('./notify');
const { effectiveOc, flightSheetMiners } = require('./rigs');

// Flight sheet atanmış rig'de, hiçbir miner'ın kapsamadığı kart türlerinin sayısı
function idleVendors(rig) {
  const out = { nvidia: 0, amd: 0 };
  if (!rig.flight_sheet_id) return out;
  const covered = new Set();
  for (const m of flightSheetMiners(rig.flight_sheet_id)) {
    if (m.gpu_vendor === 'all') { if (m.supports_nvidia) covered.add('nvidia'); if (m.supports_amd) covered.add('amd'); } else covered.add(m.gpu_vendor);
  }
  for (const g of all('SELECT vendor FROM gpus WHERE rig_id = ? AND present = 1', rig.id)) if (!covered.has(g.vendor)) out[g.vendor]++;
  return out;
}

const TYPE_LABELS = {
  offline: 'Rig çevrimdışı',
  gpu_lost: 'Kart kayboldu',
  high_temp: 'Sıcaklık yüksek',
  hashrate_drop: 'Hashrate düştü',
  hw_changed: 'Donanım değişti',
  new_gpu: 'Yeni kart algılandı',
  no_miner: 'Kart boşta',
};

function openAlert(user, rig, gpuId, type, severity, message) {
  const existing = get(`SELECT id FROM alerts WHERE rig_id = ? AND type = ? AND resolved_at IS NULL
                        AND (gpu_id IS ? OR gpu_id = ?)`, rig.id, type, gpuId, gpuId);
  if (existing) return;
  const t = now();
  const res = run(`INSERT INTO alerts (rig_id, gpu_id, type, severity, message, started_at) VALUES (?,?,?,?,?,?)`,
    rig.id, gpuId, type, severity, message, t);
  const icon = severity === 'critical' ? '🔴' : '🟠';
  notify.send(user, `${icon} ${TYPE_LABELS[type]} — ${rig.name}\n${message}`)
    .then((sent) => { if (sent) run('UPDATE alerts SET notified_at = ? WHERE id = ?', now(), res.lastInsertRowid); })
    .catch(() => {});
}

function resolveAlert(user, rig, gpuId, type) {
  const open = all(`SELECT id, message FROM alerts WHERE rig_id = ? AND type = ? AND resolved_at IS NULL
                    AND (? IS NULL OR gpu_id = ?)`, rig.id, type, gpuId, gpuId);
  for (const a of open) {
    run('UPDATE alerts SET resolved_at = ? WHERE id = ?', now(), a.id);
    notify.send(user, `✅ Düzeldi: ${TYPE_LABELS[type]} — ${rig.name}`).catch(() => {});
  }
}

function checkRig(user, rig) {
  const t = now();
  if (!rig.last_seen_at) return; // rig.conf ile eklendi, henüz hiç bağlanmadı: uyarı yok

  if (rig.hw_changed_at && rig.hw_changed_at > t - 1800) {
    openAlert(user, rig, null, 'hw_changed', 'warning',
      'Bu rig.conf farklı bir donanımdan bağlandı. Aynı dosyayı iki rig\'e kopyaladıysanız her rig için ayrı rig.conf indirin; değilse panelden anahtarı yenileyin.');
  } else {
    resolveAlert(user, rig, null, 'hw_changed');
  }

  const offline = !rig.last_seen_at || rig.last_seen_at < t - user.offline_after_sec;
  if (offline) {
    openAlert(user, rig, null, 'offline', 'critical', `${Math.round((t - rig.last_seen_at) / 60)} dakikadır bağlantı yok.`);
    return; // çevrimdışıyken diğer kontroller anlamsız
  }
  resolveAlert(user, rig, null, 'offline');

  for (const g of all('SELECT * FROM gpus WHERE rig_id = ?', rig.id)) {
    const label = `GPU ${g.idx} (${g.model}, ${g.bus_id})`;
    if (!g.present) {
      openAlert(user, rig, g.id, 'gpu_lost', 'critical', `${label} artık algılanmıyor.`);
      continue;
    }
    resolveAlert(user, rig, g.id, 'gpu_lost');

    const fresh = g.stats_at && g.stats_at > t - 120;
    if (fresh && g.temp !== null && g.temp >= user.temp_limit) {
      const sev = g.temp >= user.temp_limit + 8 ? 'critical' : 'warning';
      openAlert(user, rig, g.id, 'high_temp', sev, `${label} sıcaklığı ${Math.round(g.temp)}°C (sınır ${user.temp_limit}°C).`);
    } else if (!fresh || g.temp === null || g.temp < user.temp_limit - 3) {
      resolveAlert(user, rig, g.id, 'high_temp'); // 3°C histerezis: sınırda gidip gelmesin
    }
  }

  // Yeni takılan kart: OC atanana kadar stok ayarlarla çalışır, kullanıcı bilgilendirilir
  const eff = new Map(effectiveOc(rig.id).map((g) => [g.id, g]));
  for (const g of all('SELECT id, idx, model, bus_id, is_new, first_seen FROM gpus WHERE rig_id = ? AND present = 1', rig.id)) {
    const hasOc = !!eff.get(g.id)?.profile;
    if (g.is_new && (hasOc || g.first_seen < t - 86400)) { run('UPDATE gpus SET is_new = 0 WHERE id = ?', g.id); g.is_new = 0; }
    if (g.is_new) {
      openAlert(user, rig, g.id, 'new_gpu', 'warning', `GPU ${g.idx}: ${g.model} (${g.bus_id}). OC profili atanmadı, stok ayarlarla çalışıyor.`);
    } else {
      resolveAlert(user, rig, g.id, 'new_gpu');
    }
  }

  // Flight sheet'te bu kart türü için miner yoksa kartlar boşta kalır
  const idle = idleVendors(rig);
  const idleText = ['nvidia', 'amd'].filter((v) => idle[v])
    .map((v) => `${idle[v]} ${v === 'amd' ? 'AMD' : 'NVIDIA'} kart boşta: flight sheet'te ${v === 'amd' ? 'AMD' : 'NVIDIA'} destekli miner yok.`).join(' ');
  if (idleText) openAlert(user, rig, null, 'no_miner', 'warning', idleText);
  else resolveAlert(user, rig, null, 'no_miner');

  if (rig.miner_status !== 'running') {
    resolveAlert(user, rig, null, 'hashrate_drop'); // kullanıcı durdurduysa uyarı yok
    return;
  }
  if ((rig.miner_uptime_sec ?? 0) < 300) return; // miner yeni başladı (DAG/ısınma): ölçüm yanıltıcı
  const current = get('SELECT AVG(hashrate) AS h, COUNT(*) AS n FROM rig_stats WHERE rig_id = ? AND ts >= ?', rig.id, t - 120);
  const base = get(`SELECT AVG(hashrate) AS h, COUNT(*) AS n FROM rig_stats_5m
                    WHERE rig_id = ? AND bucket >= ? AND bucket < ?`, rig.id, t - 3 * 3600, t - 900);
  if (!current.n || base.n < 6 || !base.h) return; // yeterli geçmiş yok
  const drop = 1 - current.h / base.h;
  if (drop * 100 >= user.hashrate_drop_pct) {
    openAlert(user, rig, null, 'hashrate_drop', 'warning',
      `Hashrate son 3 saatin ortalamasına göre %${Math.round(drop * 100)} düşük.`);
  } else if (drop * 100 < user.hashrate_drop_pct / 2) {
    resolveAlert(user, rig, null, 'hashrate_drop');
  }
}

function runChecks() {
  const users = new Map(all('SELECT * FROM users').map((u) => [u.id, u]));
  for (const rig of all('SELECT * FROM rigs WHERE owner_id IS NOT NULL')) {
    const user = users.get(rig.owner_id);
    if (user) {
      try { checkRig(user, rig); } catch (err) { console.error('[alerts]', rig.id, err.message); }
    }
  }
  // Süresi geçen komutlar
  // Rig'e hiç ulaşmayan komutlar 10 dk sonra; rig'in aldığı uzun komutlar (otomatik OC) 4 saat sonra düşer
  run(`UPDATE commands SET status = 'expired', finished_at = ? WHERE created_at < ?
       AND (status = 'queued' OR (status = 'sent' AND type != 'oc_tune'))`, now(), now() - config.commandTtlSec);
  run(`UPDATE commands SET status = 'expired', finished_at = ? WHERE status = 'sent' AND type = 'oc_tune' AND created_at < ?`,
    now(), now() - 4 * 3600);
}

module.exports = { runChecks, TYPE_LABELS };
