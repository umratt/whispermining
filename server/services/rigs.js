'use strict';
const { get, all, run } = require('../db');

const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// OC değerlerinin izin verilen aralıkları (panel formu, otomatik OC ve agent aynı sınırları kullanır)
const OC_FIELDS = {
  nvidia: { core_offset: [-1000, 1000], mem_offset: [-2000, 3000], power_limit_w: [50, 450], fan_pct: [0, 100] },
  amd: { core_clock: [300, 2000], mem_clock: [300, 2500], core_mv: [700, 1200], mem_mv: [700, 1100], fan_pct: [0, 100] },
};

// OC değerlerini sınırlar içinde temizler. Hatalıysa [null, mesaj] döner.
function cleanOcParams(vendor, input, { clamp = false } = {}) {
  const fields = OC_FIELDS[vendor];
  if (!fields || !input || typeof input !== 'object') return [null, 'Geçersiz OC değerleri.'];
  const params = {};
  for (const [k, [min, max]] of Object.entries(fields)) {
    const v = input[k];
    if (v === undefined || v === null || v === '') continue; // boş = stok
    let n = Math.round(Number(v));
    if (!Number.isFinite(n)) return [null, `${k} sayı olmalı.`];
    if (n < min || n > max) {
      if (!clamp) return [null, `${k} değeri ${min} ile ${max} arasında olmalı.`];
      n = Math.min(max, Math.max(min, n));
    }
    params[k] = n;
  }
  return [params];
}

// Otomatik OC sonucunu kullanıcının profillerine ekler. Rig'e ATANMAZ: kullanıcı panelden "Uygula" der.
function saveTunedProfile(userId, r) {
  const vendor = r.vendor === 'amd' ? 'amd' : r.vendor === 'nvidia' ? 'nvidia' : null;
  if (!vendor || !r.params || typeof r.params !== 'object') return null;
  const params = {};
  for (const [k, [min, max]] of Object.entries(OC_FIELDS[vendor])) {
    const v = Number(r.params[k]);
    if (r.params[k] !== undefined && r.params[k] !== null && Number.isFinite(v)) params[k] = Math.min(max, Math.max(min, Math.round(v)));
  }
  if (!Object.keys(params).length) return null;
  const short = String(r.model || '').replace(/^(NVIDIA|AMD)\s+(GeForce\s+|Radeon\s+)?/i, '').slice(0, 20);
  const d = new Date();
  const name = `Oto · ${short} · ${String(r.algo || '').slice(0, 12)} · ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
  const t = Math.floor(Date.now() / 1000);
  const res = run('INSERT INTO oc_profiles (user_id, name, vendor, params, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    userId, name.slice(0, 40), vendor, JSON.stringify(params), t, t);
  return Number(res.lastInsertRowid);
}

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

// Havuzlar worker adında sadece İngilizce harf kabul eder: Türkçe harfler silinmesin, karşılığına çevrilsin (Dükkan → Dukkan)
const TR_ASCII = { ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U', ' ': '_' };
const sanitizeWorker = (s) => String(s).replace(/[çÇğĞıİöÖşŞüÜ ]/g, (ch) => TR_ASCII[ch])
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'rig';

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

// Her kart için geçerli OC: önce karta özel değerler, sonra karta atanan profil, sonra rig'deki aynı modele atanan profil.
// Hiçbiri yoksa (ör. sonradan takılan yeni bir model) stok ayarlar: başka modelin profili asla uygulanmaz.
function effectiveOc(rigId) {
  const byModel = new Map(all('SELECT model, oc_profile_id FROM rig_oc WHERE rig_id = ?', rigId).map((r) => [r.model, r.oc_profile_id]));
  const profiles = new Map();
  const profile = (id) => {
    if (!id) return null;
    if (!profiles.has(id)) profiles.set(id, get('SELECT id, name, vendor, params FROM oc_profiles WHERE id = ?', id) || null);
    return profiles.get(id);
  };
  return all('SELECT id, bus_id, vendor, model, present, oc_profile_id, oc_params FROM gpus WHERE rig_id = ? ORDER BY idx', rigId).map((g) => {
    // Öncelik: karta özel değerler → karta atanmış profil → modele atanmış profil → stok
    if (g.oc_params) {
      return { ...g, profile: { id: null, name: 'Karta özel', vendor: g.vendor, params: g.oc_params }, source: 'card' };
    }
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
  OC_FIELDS, cleanOcParams, saveTunedProfile,
  rigConfText,
  parseJson, ownedRig, bumpConfig, bumpConfigForFlightSheet, bumpConfigForWallet, bumpConfigForOcProfile,
  flightSheetMiners, buildAgentConfig, effectiveOc,
};
