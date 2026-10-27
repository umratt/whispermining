'use strict';
// Kazanca göre otomatik coin değiştirme. TÜM rig'ler tek coin kazar: her aday coin için bütün rig'lerdeki bütün
// kartların toplam net kazancı hesaplanır, en yükseği seçilir. Kart kart ya da rig rig ayrı seçim yapılmaz.
// Adaylar kullanıcının flight sheet'leridir; cüzdanı olup flight sheet'i olmayan coin'ler için "Oto · COIN" oluşturulur.
// Gereksiz miner yeniden başlatmasın diye: yeni coin en az %10 daha kârlı olmalı ve son değişiklikten 6 saat geçmeli.
const { get, all, run, tx, now } = require('../db');
const profit = require('./profit');
const notify = require('./notify');
const rigsSvc = require('./rigs');

const CHECK_MS = 30 * 60 * 1000;
const MIN_HOLD_SEC = 6 * 3600;
const MIN_GAIN = 0.10;
const LOG_MAX = 30;

// Flight sheet'i olmayan cüzdan coin'leri için varsayılan havuz (flight sheet formundaki listenin ilk havuzu)
const DEFAULT_POOL = {
  ETC: 'stratum+tcp://etc.2miners.com:1010', RVN: 'stratum+tcp://rvn.2miners.com:6060', ERG: 'stratum+tcp://erg.2miners.com:8888',
  KAS: 'stratum+tcp://kas.2miners.com:2020', ALPH: 'stratum+tcp://alephium.herominers.com:1199',
  CFX: 'stratum+tcp://conflux.herominers.com:1170', FIRO: 'stratum+tcp://pool.woolypooly.com:3104',
  PRL: 'stratum+tcp://prl.kryptex.network:7048', QUANTUS: 'stratum+tcp://qtc.kryptex.network:7049',
};
// Coin → bizim algoritma adı (flight sheet'i kendiliğinden kurmak için; ağ bağlantısı gerekmez)
const COIN_ALGO = { ETC: 'etchash', RVN: 'kawpow', ERG: 'autolykos2', KAS: 'kaspa', ALPH: 'alephium', CFX: 'octopus',
  FIRO: 'firopow', PRL: 'pearl', QUANTUS: 'quantus' };
const ALIAS = { PEARL: 'PRL', QUAN: 'QUANTUS' };
const tagOf = (coin) => ALIAS[String(coin || '').toUpperCase()] || String(coin || '').toUpperCase();

function state(userId) {
  const u = get('SELECT auto_switch, auto_switch_state, power_price FROM users WHERE id = ?', userId);
  return { enabled: !!u?.auto_switch, power_price: u?.power_price ?? 3, ...(rigsSvc.parseJson(u?.auto_switch_state, null) || { log: [] }) };
}

function saveState(userId, s) {
  const { enabled, power_price, ...rest } = s;
  rest.log = (rest.log || []).slice(0, LOG_MAX);
  run('UPDATE users SET auto_switch_state = ? WHERE id = ?', JSON.stringify(rest), userId);
}

// Cüzdanı olan ama flight sheet'i olmayan coin'ler için hazır flight sheet (havuz + her iki kart türünü kazan miner)
function ensureSheets(userId) {
  const sheets = all('SELECT coin FROM flight_sheets WHERE user_id = ?', userId).map((f) => tagOf(f.coin));
  const created = [];
  for (const w of all('SELECT id, coin FROM wallets WHERE user_id = ?', userId)) {
    const tag = tagOf(w.coin);
    if (sheets.includes(tag) || !DEFAULT_POOL[tag]) continue;
    const algo = COIN_ALGO[tag];
    if (!algo) continue;
    const mv = all(`SELECT mv.id, mv.algos, m.supports_nvidia, m.supports_amd FROM miner_versions mv JOIN miners m ON m.id = mv.miner_id
                    WHERE mv.is_default = 1 AND COALESCE(mv.sha256, '') != '' ORDER BY (m.supports_nvidia + m.supports_amd) DESC, m.id`)
      .find((v) => String(v.algos || '').split(',').includes(algo));
    if (!mv) continue;
    tx(() => {
      const r = run(`INSERT INTO flight_sheets (user_id, name, coin, algo, wallet_id, pools, worker_template, pool_pass, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?)`, userId, `Oto · ${tag}`, tag, algo, w.id, JSON.stringify([DEFAULT_POOL[tag]]),
      '%RIG_NAME%', 'x', now(), now());
      run('INSERT INTO flight_sheet_miners (flight_sheet_id, miner_version_id, gpu_vendor, extra_args) VALUES (?,?,?,?)',
        Number(r.lastInsertRowid), mv.id, mv.supports_nvidia && mv.supports_amd ? 'all' : mv.supports_nvidia ? 'nvidia' : 'amd', '');
    });
    sheets.push(tag);
    created.push(tag);
  }
  return created;
}

// Her aday flight sheet için tüm rig'lerdeki tüm kartların toplam günlük net kazancı (USD)
async function evaluate(userId) {
  const s = state(userId);
  const models = all(`SELECT g.model, COUNT(*) AS count FROM gpus g JOIN rigs r ON r.id = g.rig_id
                      WHERE r.owner_id = ? AND g.present = 1 GROUP BY g.model`, userId);
  const rk = await profit.ranking(models);
  const created = ensureSheets(userId); // cüzdanı olup flight sheet'i olmayan coin'ler
  const elecUsd = (w) => (w ? (w * 24 / 1000) * Number(s.power_price || 0) / rk.usd_try : 0);
  const sheets = all('SELECT id, name, coin, algo, wallet_id FROM flight_sheets WHERE user_id = ? AND wallet_id IS NOT NULL', userId);
  const candidates = sheets.map((f) => {
    const tag = tagOf(f.coin);
    let net = 0; let gross = 0; let mining = 0; let idle = 0; let known = false;
    for (const c of rk.cards) {
      const row = c.rows.find((r) => r.tag === tag && r.our_algo === f.algo);
      if (row) {
        known = true;
        gross += row.usd * c.count;
        net += (row.usd - elecUsd(row.power)) * c.count;
        mining += c.count;
      } else idle += c.count; // bu kart bu coin'i kazamaz: boşta kalır (kazanç da maliyet de yok sayılır)
    }
    return { fs_id: f.id, name: f.name, coin: f.coin, algo: f.algo, known, net, gross, mining, idle };
  }).filter((c) => c.known).sort((a, b) => b.net - a.net);
  const rigs = all('SELECT flight_sheet_id, COUNT(*) AS n FROM rigs WHERE owner_id = ? GROUP BY flight_sheet_id ORDER BY n DESC', userId);
  const currentId = rigs.find((r) => r.flight_sheet_id)?.flight_sheet_id || null;
  return { candidates, current: candidates.find((c) => c.fs_id === currentId) || null, current_fs_id: currentId,
    best: candidates[0] || null, created, usd_try: rk.usd_try, power_price: s.power_price, rig_count: rigs.reduce((n, r) => n + r.n, 0) };
}

const fmt = (usd, tr) => `${Math.round(usd * tr).toLocaleString('tr-TR')} ₺`;

// Kurallara göre değiştir. force: açma anında / "şimdi değiştir" ile 6 saat beklemeden geçer (eşik yine geçerli)
async function check(userId, { force = false } = {}) {
  const s = state(userId);
  const ev = await evaluate(userId);
  const t = now();
  s.last_check = t;
  let decision = 'Değişiklik gerekmiyor';
  const best = ev.best;
  // Çevrimiçi bir rig'de otomatik OC sürüyorsa bekle (kapalı rig'deki eski kayıt engellemesin)
  const tuning = get(`SELECT 1 FROM rigs WHERE owner_id = ? AND last_seen_at >= ? AND tune_state LIKE '%"status":"running"%'`, userId, t - 120);
  if (!s.enabled) decision = 'Kapalı';
  else if (!best) decision = 'Aday yok: cüzdan ve flight sheet ekleyin';
  else if (best.fs_id === ev.current_fs_id) decision = `En kârlısı zaten ${best.coin}`;
  else if (tuning) decision = 'Otomatik OC sürüyor; bitince tekrar bakılacak';
  else {
    const cur = ev.current;
    const gain = cur && cur.net > 0 ? best.net / cur.net - 1 : Infinity;
    const held = s.last_switch_at ? t - s.last_switch_at : Infinity;
    if (cur && gain < MIN_GAIN) decision = `${best.coin} sadece %${(gain * 100).toFixed(1)} daha kârlı (en az %10 gerekir)`;
    else if (!force && held < MIN_HOLD_SEC) decision = `${best.coin} daha kârlı; son değişiklikten 6 saat geçince geçilecek`;
    else {
      run('UPDATE rigs SET flight_sheet_id = ?, config_version = config_version + 1 WHERE owner_id = ?', best.fs_id, userId);
      s.last_switch_at = t;
      ev.current_fs_id = best.fs_id;
      ev.current = best;
      const msg = `${cur ? cur.coin : 'yok'} → ${best.coin}: tüm rig'ler günde ~${fmt(best.net, ev.usd_try)} net`
        + (cur ? ` (önce ~${fmt(cur.net, ev.usd_try)})` : '');
      s.log = [{ at: t, from: cur?.coin || null, to: best.coin, net_before: cur?.net ?? null, net_after: best.net, msg }, ...(s.log || [])];
      decision = `Geçildi: ${msg}`;
      const user = get('SELECT id, telegram_chat_id FROM users WHERE id = ?', userId);
      notify.send(user, `🔄 Otomatik coin değiştirme\n${msg}`).catch(() => {});
    }
  }
  s.last_decision = decision;
  saveState(userId, s);
  return { ...ev, decision, state: state(userId) };
}

function start() {
  const tick = async () => {
    for (const u of all('SELECT id FROM users WHERE auto_switch = 1')) {
      try { await check(u.id); } catch (err) { console.error('[autoswitch]', u.id, err.message); }
    }
  };
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, CHECK_MS).unref?.();
}

module.exports = { evaluate, check, state, start, ensureSheets, MIN_GAIN, MIN_HOLD_SEC };
