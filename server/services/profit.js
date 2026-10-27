'use strict';
// Kart başına günlük kazanç sıralaması. Veri: WhatToMine (coin ağı + kart hashrate/güç tablosu), kur: Binance.
// WhatToMine'ın coins.json'u kendi varsayılan donanımına göre hesaplar; biz bunu kartımızın hashrate'ine oranlarız:
//   kartın günlük geliri = coin'in varsayılan geliri × (kartın hashrate'i / varsayılan hashrate)  (algoritma başına)
const WTM = 'https://whattomine.com';
const TTL_MS = 15 * 60 * 1000;
const UA = { 'user-agent': 'Mozilla/5.0 (WhisperMining panel)' };

// WhatToMine algoritma adı → hashrate tablosundaki anahtar
const ALGO_KEY = {
  Pearl: 'prl', QPoW: 'qpw', ProgPow: 'ppw', ProgPowZ: 'ppw', FishHash: 'fh', Cuckaroo29: 'cr29', Blake3DCR: 'b3d',
  EvrProgPow: 'evr', Karlsenhashv2: 'krh', Qhash: 'qh', CuckooCycle: 'cc', FiroPow: 'fpw', CryptoNightGPU: 'cng',
  Verthash: 'vh', Xelishashv3: 'xl3', KawPow: 'kpw', Autolykos: 'al', Cuckatoo32: 'ct32', BeamHashIII: 'eqb',
  NexaPow: 'nx', Ethash: 'eth', Etchash: 'e4g', DynexSolve: 'ds', SHA3x: 's3x', Abelhash: 'abl', MeowPow: 'mp',
  Octopus: 'ops', Zhash: 'zh',
};
// WhatToMine algoritması → bizim miner kataloğundaki algoritma adı (panelden kazılabilir mi?)
const OUR_ALGO = { Pearl: 'pearl', QPoW: 'quantus', KawPow: 'kawpow', Etchash: 'etchash', Autolykos: 'autolykos2', Octopus: 'octopus',
  FiroPow: 'firopow', BeamHashIII: 'beamhash' };

// Kart adı → WhatToMine kart anahtarı. P106-100, GTX 1060 6GB ile aynı çiptir (GP106).
const CARD_KEYS = [
  [/P106-?100|GTX 1060 6/i, '10606'], [/RTX 3080 Ti/i, '38Ti'], [/RTX 3080/i, '3080'], [/RTX 3090 Ti/i, '39Ti'], [/RTX 3090/i, '3090'],
  [/RTX 3070 Ti/i, '37Ti'], [/RTX 3070/i, '3070'], [/RTX 3060 Ti/i, '3060Ti'], [/RTX 3060/i, '3060'], [/RTX 4090/i, '4090'],
  [/RTX 4080 Super/i, '48s'], [/RTX 4080/i, '4080'], [/RTX 4070 Ti Super/i, '47Tis'], [/RTX 4070 Ti/i, '47Ti'], [/RTX 4070 Super/i, '47s'],
  [/RTX 4070/i, '47'], [/RTX 4060 Ti/i, '46Ti'], [/RTX 4060/i, '46'], [/RTX 2080 Ti/i, '2080Ti'], [/RTX 2080/i, '2080'],
  [/RTX 2070/i, '2070'], [/RTX 2060/i, '2060'], [/GTX 1660 Super/i, '166s'], [/GTX 1660 Ti/i, '1660Ti'], [/GTX 1660/i, '1660'],
  [/GTX 1080 Ti/i, '1080Ti'], [/GTX 1080/i, '1080'], [/GTX 1070 Ti/i, '1070Ti'], [/GTX 1070/i, '1070'], [/GTX 1050 Ti/i, '1050Ti'],
  [/RX 580/i, '580'], [/RX 570/i, '570'], [/RX 480/i, '480'], [/RX 470/i, '470'], [/RX 6900|RX 6950/i, '69xt'], [/RX 6800 XT/i, '68xt'],
  [/RX 6800/i, '68'], [/RX 6700/i, '67xt'], [/RX 6600 XT|RX 6650/i, '66xt'], [/RX 6600/i, '66'], [/RX 5700 XT/i, '5700xt'],
  [/RX 5700/i, '5700'], [/RX 5600/i, '5600xt'], [/RX 7900 XTX/i, '79xtx'], [/RX 7900/i, '79xt'], [/RX 7800/i, '78xt'],
  [/Vega 64/i, 'vega64'], [/Vega 56/i, 'vega56'], [/Radeon VII/i, 'vii'],
];
// Bazı algoritmalar her kartta çalışmaz (agent'taki ALGO_CARDS ile aynı kural): kazanamayan kart hesaba katılmaz
const ALGO_CARDS = {
  pearl: (l) => (/^(RTX|GTX)/.test(l) && !/P10[0246]|GTX (9|10)\d\d/.test(l)) || /RX 6[6-9]\d\d/.test(l),
  quantus: (l) => /RTX [3-9]\d{3}|RX [679]\d{3}/.test(l),
};
const canMine = (ourAlgo, key) => !ALGO_CARDS[ourAlgo] || ALGO_CARDS[ourAlgo](cardLabel(key));
const cardKey = (model) => (CARD_KEYS.find(([re]) => re.test(model)) || [])[1] || null;

let cache = null;
let loading = null;

async function getJson(url) {
  const res = await fetch(url, { headers: { ...UA, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function getText(url) {
  // Aynı adres "accept: json" ile JSON döner; sayfanın kendisi için açıkça HTML istenir
  const res = await fetch(url, { headers: { ...UA, accept: 'text/html' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

// coins.json'un hesapladığı varsayılan donanım: ana sayfadaki factor[..._hr] alanları
function parseDefaultFactors(html) {
  const out = {};
  for (const m of html.matchAll(/value="([0-9.]+)" name="factor\[([a-z0-9]+)_hr\]"/g)) out[m[2]] = Number(m[1]);
  return out;
}

async function load() {
  const [coins, factors, page, prices] = await Promise.all([
    getJson(`${WTM}/coins.json`), getJson(`${WTM}/gpus/factors.json`), getText(`${WTM}/coins`),
    getJson('https://api.binance.com/api/v3/ticker/price?symbols=%5B%22BTCUSDT%22,%22USDTTRY%22%5D'),
  ]);
  const defaults = parseDefaultFactors(page);
  if (Object.keys(defaults).length < 10) throw new Error('WhatToMine varsayılan değerleri okunamadı');
  const px = Object.fromEntries(prices.map((p) => [p.symbol, Number(p.price)]));
  const list = Object.entries(coins.coins || {})
    .filter(([name, c]) => !name.startsWith('Nicehash') && !c.lagging)
    .map(([name, c]) => ({
      name, tag: c.tag, algo: c.algorithm, key: ALGO_KEY[c.algorithm] || null, our_algo: OUR_ALGO[c.algorithm] || null,
      btc_default: Number(c.btc_revenue), btc_default24: Number(c.btc_revenue24), coins_default: Number(c.estimated_rewards),
      btc_rate: Number(c.exchange_rate), btc_rate24: Number(c.exchange_rate24), volume_btc: Number(c.exchange_rate_vol) || 0,
      block_time: Number(c.block_time), block_reward: Number(c.block_reward), difficulty: Number(c.difficulty),
      nethash: Number(c.nethash), market_cap: c.market_cap, updated: c.timestamp,
    }));
  cache = { at: Date.now(), list, factors, defaults, btc_usd: px.BTCUSDT, usd_try: px.USDTTRY };
  return cache;
}

async function data() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  if (!loading) loading = load().finally(() => { loading = null; });
  try {
    return await loading;
  } catch (err) {
    if (cache) return { ...cache, stale: err.message }; // eski veriyle devam et
    throw err;
  }
}

// models: [{ model, count }] → her kart için tüm coin'lerin günlük kazancı (kartın kazamadığı coin'ler hariç)
async function ranking(models) {
  const d = await data();
  const usd = (btc) => btc * d.btc_usd;
  const cards = models.map((m) => {
    const key = cardKey(m.model);
    const f = key ? d.factors[key] || {} : {};
    const rows = [];
    for (const c of d.list) {
      const hr = c.key ? f[`${c.key}_hr`] : 0;
      const base = c.key ? d.defaults[c.key] : 0;
      if (!hr || !base || !c.btc_default || !canMine(c.our_algo, key)) continue; // bu kart bu algoritmayı kazamıyor ya da veri yok
      const ratio = hr / base;
      rows.push({ name: c.name, tag: c.tag, algo: c.algo, our_algo: c.our_algo, hashrate: hr, power: f[`${c.key}_p`] || null,
        coins: c.coins_default * ratio, usd: usd(c.btc_default * ratio) });
    }
    rows.sort((a, b) => b.usd - a.usd);
    return { model: m.model, count: m.count, key, rows };
  });
  return { updated_at: Math.floor(d.at / 1000), btc_usd: d.btc_usd, usd_try: d.usd_try, stale: d.stale || null, cards };
}

// WhatToMine kart anahtarı → okunur ad (kart seçicide)
const LABELS = {
  46: 'RTX 4060', '46Ti': 'RTX 4060 Ti', 47: 'RTX 4070', '47s': 'RTX 4070 Super', '47Ti': 'RTX 4070 Ti', '47Tis': 'RTX 4070 Ti Super',
  4080: 'RTX 4080', '48s': 'RTX 4080 Super', 4090: 'RTX 4090', 56: 'RTX 5060', '56Ti': 'RTX 5060 Ti', 57: 'RTX 5070', '57Ti': 'RTX 5070 Ti',
  58: 'RTX 5080', 59: 'RTX 5090', 3060: 'RTX 3060', '3060Ti': 'RTX 3060 Ti', 3070: 'RTX 3070', '37Ti': 'RTX 3070 Ti', 3080: 'RTX 3080',
  '38Ti': 'RTX 3080 Ti', 3090: 'RTX 3090', '39Ti': 'RTX 3090 Ti', 2060: 'RTX 2060', 2070: 'RTX 2070', 2080: 'RTX 2080', '2080Ti': 'RTX 2080 Ti',
  1660: 'GTX 1660', '1660Ti': 'GTX 1660 Ti', '166s': 'GTX 1660 Super', 1070: 'GTX 1070', '1070Ti': 'GTX 1070 Ti', 1080: 'GTX 1080',
  '1080Ti': 'GTX 1080 Ti', '1050Ti': 'GTX 1050 Ti', 10606: 'GTX 1060 6GB / P106-100',
  470: 'RX 470', 480: 'RX 480', 570: 'RX 570', 580: 'RX 580', 380: 'R9 380', fury: 'R9 Fury', vega56: 'Vega 56', vega64: 'Vega 64',
  vii: 'Radeon VII', 5600: 'RX 5600', '5600xt': 'RX 5600 XT', '55xt8': 'RX 5500 XT 8GB', 5700: 'RX 5700', '5700xt': 'RX 5700 XT',
  66: 'RX 6600', '66xt': 'RX 6600 XT', '67xt': 'RX 6700 XT', 68: 'RX 6800', '68xt': 'RX 6800 XT', '69xt': 'RX 6900 XT',
  '78xt': 'RX 7800 XT', '79xt': 'RX 7900 XT', '79xtx': 'RX 7900 XTX', a2: 'Arc A380', a4: 'Arc A580', a45: 'Arc A750', a5: 'Arc A770',
};
const cardLabel = (key) => LABELS[key] || String(key);

// Hashrate birimleri (WhatToMine'ın kullandığı): emin olunanlar
const UNITS = { kpw: 'MH/s', e4g: 'MH/s', eth: 'MH/s', evr: 'MH/s', ppw: 'MH/s', fpw: 'MH/s', al: 'MH/s', mp: 'MH/s', nx: 'MH/s',
  fh: 'MH/s', zh: 'Sol/s', eqb: 'Sol/s', cr29: 'G/s', ct32: 'G/s', cc: 'G/s', cng: 'H/s', vh: 'MH/s', krh: 'MH/s', abl: 'MH/s' };

// WhatToMine hesaplayıcısı gibi: seçilen kart seti (anahtar + adet) için tüm coin'ler, kart setinin toplamı
async function calc(selection) {
  const d = await data();
  const sel = selection.filter((s) => d.factors[s.key] && s.count > 0);
  const rows = [];
  for (const c of d.list) {
    if (!c.key || !d.defaults[c.key] || !c.btc_default) continue;
    let hr = 0; let power = 0; let cards = 0;
    for (const s of sel) {
      const f = d.factors[s.key];
      if (f[`${c.key}_hr`] && canMine(c.our_algo, s.key)) {
        hr += f[`${c.key}_hr`] * s.count; power += (f[`${c.key}_p`] || 0) * s.count; cards += s.count;
      }
    }
    if (!hr) continue;
    const ratio = hr / d.defaults[c.key];
    rows.push({ name: c.name, tag: c.tag, algo: c.algo, our_algo: c.our_algo, hashrate: hr, unit: UNITS[c.key] || '', power, cards,
      coins: c.coins_default * ratio, usd: c.btc_default * ratio * d.btc_usd, usd24: (c.btc_default24 || c.btc_default) * ratio * d.btc_usd,
      price_usd: c.btc_rate * d.btc_usd, price_change: c.btc_rate24 ? c.btc_rate / c.btc_rate24 - 1 : null,
      volume_usd: c.volume_btc * d.btc_usd, market_cap: c.market_cap, block_time: c.block_time, block_reward: c.block_reward,
      difficulty: c.difficulty, nethash: c.nethash });
  }
  return { updated_at: Math.floor(d.at / 1000), btc_usd: d.btc_usd, usd_try: d.usd_try, stale: d.stale || null, rows,
    gpus: Object.keys(d.factors).map((key) => ({ key, label: cardLabel(key) })).sort((a, b) => a.label.localeCompare(b.label, 'tr')) };
}

module.exports = { ranking, calc, cardKey, cardLabel };
