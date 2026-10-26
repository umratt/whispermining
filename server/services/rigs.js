'use strict';
const { get, all, run } = require('../db');

const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// Sahibin rig'ini getir; başkasınınsa null döner (her panel işlemi buradan geçer)
function ownedRig(userId, rigId) {
  return get('SELECT * FROM rigs WHERE id = ? AND owner_id = ?', String(rigId), userId) || null;
}

function bumpConfig(rigId) {
  run('UPDATE rigs SET config_version = config_version + 1 WHERE id = ?', rigId);
}
function bumpConfigForFlightSheet(fsId) {
  run('UPDATE rigs SET config_version = config_version + 1 WHERE flight_sheet_id = ?', fsId);
}
function bumpConfigForWallet(walletId) {
  run(`UPDATE rigs SET config_version = config_version + 1
       WHERE flight_sheet_id IN (SELECT id FROM flight_sheets WHERE wallet_id = ?)`, walletId);
}
function bumpConfigForOcProfile(ocId) {
  run(`UPDATE rigs SET config_version = config_version + 1
       WHERE id IN (SELECT rig_id FROM rig_oc WHERE oc_profile_id = ?) OR id IN (SELECT rig_id FROM gpus WHERE oc_profile_id = ?)`, ocId, ocId);
}

const sanitizeWorker = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'rig';

function flightSheetMiners(fsId) {
  return all(`SELECT fm.gpu_vendor, fm.extra_args, mv.id AS miner_version_id, mv.version, mv.download_url, mv.sha256,
                     m.name, m.api_type, m.supports_nvidia, m.supports_amd
              FROM flight_sheet_miners fm
              JOIN miner_versions mv ON mv.id = fm.miner_version_id
              JOIN miners m ON m.id = mv.miner_id
              WHERE fm.flight_sheet_id = ? ORDER BY fm.id`, fsId);
}

// Agent'a gönderilecek yapılandırma. Bilinçli olarak sadece madencilik için gereken
// bilgiler var: havuz, cüzdan adresi, worker adı, miner indirme bilgisi, OC değerleri.
function buildAgentConfig(rig) {
  let flightSheet = null;
  if (rig.flight_sheet_id) {
    const fs = get(`SELECT f.*, w.address AS wallet_address FROM flight_sheets f
                    LEFT JOIN wallets w ON w.id = f.wallet_id WHERE f.id = ?`, rig.flight_sheet_id);
    if (fs) {
      const worker = sanitizeWorker(fs.worker_template
        .replace(/%RIG_NAME%/g, rig.name)
        .replace(/%RIG_ID%/g, rig.id.slice(0, 8)));
      flightSheet = {
        id: fs.id,
        name: fs.name,
        coin: fs.coin,
        algo: fs.algo,
        wallet: fs.wallet_address || '',
        pools: parseJson(fs.pools, []),
        worker,
        pool_pass: fs.pool_pass,
        miners: flightSheetMiners(fs.id).map((m) => ({
          name: m.name,
          api_type: m.api_type,
          version: m.version,
          download_url: m.download_url,
          sha256: m.sha256,
          gpu_vendor: m.gpu_vendor,
          extra_args: m.extra_args,
        })),
      };
    }
  }

  const overclock = effectiveOc(rig.id).filter((g) => g.present).map((g) => ({
    bus_id: g.bus_id, vendor: g.vendor, profile: g.profile ? g.profile.name : null, params: g.profile ? parseJson(g.profile.params, {}) : null,
  }));

  return { config_version: rig.config_version, rig_name: rig.name, flight_sheet: flightSheet, overclock };
}

// Her kart için geçerli OC profili: önce karta özel atama, sonra rig'deki aynı modele atanan profil.
// Hiçbiri yoksa (ör. sonradan takılan yeni bir model) stok ayarlar: başka modelin profili asla uygulanmaz.
function effectiveOc(rigId) {
  const byModel = new Map(all('SELECT model, oc_profile_id FROM rig_oc WHERE rig_id = ?', rigId).map((r) => [r.model, r.oc_profile_id]));
  const profiles = new Map();
  const profile = (id) => {
    if (!id) return null;
    if (!profiles.has(id)) profiles.set(id, get('SELECT id, name, vendor, params FROM oc_profiles WHERE id = ?', id) || null);
    return profiles.get(id);
  };
  return all('SELECT id, bus_id, vendor, model, present, oc_profile_id FROM gpus WHERE rig_id = ? ORDER BY idx', rigId).map((g) => {
    let p = profile(g.oc_profile_id);
    let source = p ? 'gpu' : null;
    if (!p) { p = profile(byModel.get(g.model)); source = p ? 'model' : null; }
    if (p && p.vendor !== g.vendor) { p = null; source = null; }
    return { ...g, profile: p, source };
  });
}

// Flash belleğin FAT bölümüne konacak dosya. Gizli anahtar sadece burada, bir kez görünür.
function rigConfText(rig, secret, publicUrl) {
  return [
    '# WhisperMining rig ayar dosyası',
    '# Flash belleğin FAT bölümüne "rig.conf" adıyla kopyalayın.',
    '# Bu dosyadaki anahtar sadece bu rig içindir; başkasıyla paylaşmayın.',
    `# Oluşturulma: ${new Date().toISOString()}`,
    '',
    `RIG_ID=${rig.id}`,
    `RIG_SECRET=${secret}`,
    `RIG_NAME=${rig.name}`,
    `SERVER_URL=${publicUrl}`,
    '',
  ].join('\n');
}

module.exports = {
  rigConfText,
  parseJson, ownedRig, bumpConfig, bumpConfigForFlightSheet, bumpConfigForWallet, bumpConfigForOcProfile,
  flightSheetMiners, buildAgentConfig, effectiveOc,
};
