#!/usr/bin/env node
'use strict';
/*
 * Sahte agent simülatörü: gerçek rig yokken paneli test etmek için.
 * Gerçek agent'ın (Aşama 2) yapacağı her şeyi API üzerinden taklit eder:
 * kayıt → eşleştirme kodu → donanım bildirimi → istatistik → ayar/komut uygulama.
 *
 * Kullanım:
 *   node simulator/fake-agent.js [--url http://localhost:3120/mining] [--rigs 1,2,3] [--interval 10]
 *                                [--hot 2] [--drop-gpu 2] [--reset]
 *   --hot N       N. rig'in ilk kartı ısınır (sıcaklık uyarısını test etmek için)
 *   --drop-gpu N  N. rig'den 2 dakika sonra bir kart "kaybolur"
 *   --reset       kayıtlı kimlikleri sil, rig'ler yeniden kayıt olsun
 *   --conf DOSYA  panelden indirilen rig.conf ile tek rig çalıştır (flash'tan açılış gibi; kod gerekmez)
 *                 hangi donanımın taklit edileceği --rigs ile seçilir, ör: --conf rig.conf --rigs 3
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def; };
const BASE = String(opt('url', 'http://localhost:3120/mining')).replace(/\/+$/, '');
const API = `${BASE}/api/agent/v1`;
const INTERVAL = Number(opt('interval', 10)) * 1000;
const HOT = Number(opt('hot', 0));
const DROP = Number(opt('drop-gpu', 0));
const STATE_FILE = path.join(__dirname, '.sim-state.json');
const CONF = opt('conf', null);

// rig.conf: KEY=VALUE satırları, # yorum. Windows'ta düzenlenmiş olabilir (CRLF, BOM).
function readRigConf(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const AGENT_VERSION = '0.1.0-sim';

if (opt('reset', false) && fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
const saved = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(saved, null, 2));

// Donanımın: 2× RX 580, 12× P106-100, 3× RTX 3080 → 3 rig
const MODELS = {
  p106: { vendor: 'nvidia', model: 'NVIDIA P106-100', vram_mb: 6144, driver: '535.183.01', vbios: '86.06.3C.00.0F',
    hash: { etchash: 21.2e6, kawpow: 10.4e6, autolykos2: 45e6 }, power: { etchash: 82, kawpow: 102, autolykos2: 74 }, idle: 8 },
  rx580: { vendor: 'amd', model: 'AMD Radeon RX 580 8GB', vram_mb: 8192, driver: 'amdgpu 22.20 OpenCL', vbios: '113-1E3871U-O4C',
    hash: { etchash: 30.5e6, kawpow: 12.2e6, autolykos2: 56e6 }, power: { etchash: 118, kawpow: 140, autolykos2: 110 }, idle: 12 },
  rtx3080: { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3080', vram_mb: 10240, driver: '535.183.01', vbios: '94.02.42.00.A9',
    hash: { etchash: 96.5e6, kawpow: 47e6, autolykos2: 220e6 }, power: { etchash: 228, kawpow: 290, autolykos2: 200 }, idle: 18 },
};
const PRESETS = {
  1: { hostname: 'rig-karma', cards: ['rx580', 'rx580', 'p106', 'p106', 'p106', 'p106'] },
  2: { hostname: 'rig-p106', cards: ['p106', 'p106', 'p106', 'p106', 'p106', 'p106', 'p106', 'p106'] },
  3: { hostname: 'rig-rtx', cards: ['rtx3080', 'rtx3080', 'rtx3080'] },
};
let which = String(opt('rigs', CONF ? '3' : '1,2,3')).split(',').map(Number).filter((n) => PRESETS[n]);
if (CONF) which = which.slice(0, 1); // bir rig.conf = bir rig

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (v, pct) => v * (1 + (Math.random() * 2 - 1) * pct);

class FakeRig {
  constructor(n) {
    this.n = n;
    this.preset = PRESETS[n];
    this.key = `rig${n}`;
    this.creds = saved[this.key] || null;
    this.fingerprint = this.creds?.fingerprint || saved[`${this.key}_fp`] || crypto.randomBytes(12).toString('hex');
    saved[`${this.key}_fp`] = this.fingerprint; save(); // donanım kimliği sabit kalsın
    if (CONF) this.loadConf();
    this.gpus = this.preset.cards.map((c, i) => ({ type: c, ...MODELS[c], index: i, bus_id: `${(i + 1).toString(16).padStart(2, '0')}:00.0`,
      uuid: `GPU-${crypto.randomBytes(8).toString('hex')}`, temp: 35, fan: 30, accepted: 0, rejected: 0, present: true }));
    this.configVersion = 0;
    this.config = null;
    this.miner = 'stopped';
    this.minerStartedAt = null;
    this.startedAt = Date.now();
    this.offlineUntil = 0;
  }

  loadConf() {
    const c = readRigConf(CONF);
    if (!c.RIG_ID || !c.RIG_SECRET) throw new Error(`${CONF}: RIG_ID / RIG_SECRET yok`);
    this.creds = { rig_id: c.RIG_ID, rig_secret: c.RIG_SECRET, fingerprint: this.fingerprint };
    this.confName = c.RIG_NAME;
    if (c.SERVER_URL && !opt('url', null)) this.api = `${c.SERVER_URL.replace(/\/+$/, '')}/api/agent/v1`;
  }

  log(...m) { console.log(`[${this.preset.hostname}]`, ...m); }

  async call(method, p, body) {
    const headers = { 'content-type': 'application/json' };
    if (this.creds) headers.authorization = `Bearer ${this.creds.rig_id}.${this.creds.rig_secret}`;
    const res = await fetch(`${this.api || API}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`${method} ${p} → ${res.status} ${data.error || ''}`); e.status = res.status; e.code = data.error; throw e; }
    return data;
  }

  async register() {
    const r = await this.call('POST', '/register', {
      hw_fingerprint: this.fingerprint, hostname: this.preset.hostname, agent_version: AGENT_VERSION, os_info: 'Ubuntu 22.04.4 LTS (simülasyon)',
    });
    this.creds = { rig_id: r.rig_id, rig_secret: r.rig_secret, fingerprint: this.fingerprint };
    saved[this.key] = this.creds; save();
    this.lastCode = r.pairing_code;
    this.showCode(r.pairing_code);
  }

  showCode(code) {
    console.log(`\n  ┌────────────────────────────────────────┐\n  │  ${this.preset.hostname.padEnd(10)} eşleştirme kodu:  ${code}  │\n  └────────────────────────────────────────┘\n`);
  }

  hardware() {
    return {
      hw_fingerprint: this.fingerprint, agent_version: AGENT_VERSION, os_info: 'Ubuntu 22.04.4 LTS (simülasyon)', cpu_model: 'Intel Celeron G3930 @ 2.90GHz', ram_total_mb: 3900,
      gpus: this.gpus.filter((g) => g.present).map((g) => ({ index: g.index, bus_id: g.bus_id, vendor: g.vendor, model: g.model,
        vram_mb: g.vram_mb, driver: g.driver, vbios: g.vbios, uuid: g.uuid })),
    };
  }

  // Bu kart için çalışan bir miner var mı?
  minerFor(g) {
    const fs = this.config?.flight_sheet;
    if (!fs) return null;
    return fs.miners.find((m) => m.gpu_vendor === 'all' || m.gpu_vendor === g.vendor) || null;
  }

  ocFor(g) { return this.config?.overclock?.find((o) => o.bus_id === g.bus_id)?.params || null; }

  sample() {
    const algo = this.config?.flight_sheet?.algo;
    const running = this.miner === 'running';
    return this.gpus.filter((g) => g.present).map((g, i) => {
      const mining = running && this.minerFor(g);
      const oc = this.ocFor(g) || {};
      let hash = 0; let power = g.idle;
      if (mining) {
        hash = g.hash[algo] ?? g.hash.etchash;
        power = g.power[algo] ?? g.power.etchash;
        if (g.vendor === 'nvidia') {
          hash *= 1 + (oc.mem_offset || 0) / 12000;
          if (oc.power_limit_w) { hash *= Math.min(1, 0.55 + 0.45 * (oc.power_limit_w / power)); power = Math.min(power, oc.power_limit_w); }
        } else {
          if (oc.mem_clock) hash *= oc.mem_clock / 2000;
          if (oc.core_mv) power *= (oc.core_mv / 1000) ** 1.6;
        }
        hash = jitter(hash, 0.02);
        power = jitter(power, 0.03);
      }
      // Sıcaklık: güce ve fana göre hedefe yavaşça yaklaşır
      const fan = oc.fan_pct ?? Math.min(100, 30 + Math.max(0, g.temp - 45) * 2.2);
      let target = 30 + power * (g.type === 'rtx3080' ? 0.15 : 0.32) - fan * 0.12;
      if (HOT === this.n && i === 0) target += 30;
      g.temp += (target - g.temp) * 0.25 + (Math.random() - 0.5);
      g.fan = fan;
      if (mining && Math.random() < hash / 2.5e8 + 0.3) g.accepted += 1;
      if (mining && Math.random() < 0.004) g.rejected += 1;
      const nv = g.vendor === 'nvidia';
      return {
        bus_id: g.bus_id, hashrate: Math.round(hash), temp: Math.round(g.temp), mem_temp: g.type === 'rtx3080' ? Math.round(g.temp + 22) : null,
        fan: Math.round(fan), power: Math.round(power),
        core_clk: mining ? Math.round((nv ? 1500 : 1150) + (oc.core_offset || 0)) : 300,
        mem_clk: mining ? Math.round(oc.mem_clock || (nv ? 4000 + (oc.mem_offset || 0) / 2 : 2000)) : 400,
        accepted: g.accepted, rejected: g.rejected,
      };
    });
  }

  async applyConfig() {
    this.config = await this.call('GET', '/config');
    this.configVersion = this.config.config_version;
    const fs = this.config.flight_sheet;
    if (!fs) {
      this.miner = 'stopped';
      this.log('Flight sheet yok → miner durdu');
      return;
    }
    for (const m of fs.miners) {
      if (!m.sha256) this.log(`UYARI: ${m.name} ${m.version} için SHA256 yok. Gerçek agent bunu indirmez; simülatör devam ediyor.`);
    }
    this.log(`Ayar v${this.configVersion}: ${fs.coin}/${fs.algo} · ${fs.miners.map((m) => `${m.name} ${m.version}`).join(' + ')} · worker ${fs.worker}`);
    if (this.miner !== 'stopped' || !this.userStopped) this.startMiner();
  }

  startMiner() {
    if (!this.config?.flight_sheet) { this.miner = 'stopped'; return false; }
    this.miner = 'starting';
    this.minerStartedAt = Date.now();
    this.userStopped = false;
    setTimeout(() => { if (this.miner === 'starting') this.miner = 'running'; }, 8000);
    return true;
  }

  async runCommands() {
    const { commands } = await this.call('GET', '/commands');
    for (const c of commands) {
      this.log('Komut:', c.type);
      let status = 'done'; let output = '';
      switch (c.type) {
        case 'miner_start': if (!this.startMiner()) { status = 'failed'; output = 'Flight sheet atanmamış'; } else output = 'Miner başlatıldı'; break;
        case 'miner_stop': this.miner = 'stopped'; this.userStopped = true; output = 'Miner durduruldu'; break;
        case 'miner_restart': this.startMiner(); output = 'Miner yeniden başlatıldı'; break;
        case 'apply_oc': output = `${this.config?.overclock?.filter((o) => o.params).length || 0} karta OC uygulandı`; break;
        case 'reboot':
          await this.call('POST', `/commands/${c.id}/result`, { status: 'done', exit_code: 0, output: 'Yeniden başlatılıyor' });
          this.offlineUntil = Date.now() + 45_000;
          this.miner = 'stopped';
          this.gpus.forEach((g) => { g.accepted = 0; g.rejected = 0; });
          this.log('Yeniden başlatılıyor (45 sn çevrimdışı)');
          continue;
        default: status = 'failed'; output = 'Bilinmeyen komut';
      }
      await this.call('POST', `/commands/${c.id}/result`, { status, exit_code: status === 'done' ? 0 : 1, output });
    }
  }

  async loop() {
    for (;;) {
      try {
        if (Date.now() < this.offlineUntil) { await sleep(2000); continue; }
        if (this.offlineUntil) { this.offlineUntil = 0; this.startedAt = Date.now(); await this.call('PUT', '/hardware', this.hardware()); this.configVersion = 0; }
        if (!this.creds) await this.register();

        const st = await this.call('GET', '/status');
        if (!st.paired) {
          if (!this.hwSent) { await this.call('PUT', '/hardware', this.hardware()); this.hwSent = true; }
          if (st.pairing_code !== this.lastCode) { this.lastCode = st.pairing_code; this.showCode(st.pairing_code); }
          await sleep(5000);
          continue;
        }
        if (!this.paired) { this.paired = true; this.log(`Eşleşti: "${st.rig_name}"`); await this.call('PUT', '/hardware', this.hardware()); }

        if (DROP === this.n && !this.dropped && Date.now() - this.startedAt > 120_000) {
          this.dropped = true;
          this.gpus[this.gpus.length - 1].present = false;
          this.log('Bir kart kayboldu (simülasyon)');
          await this.call('PUT', '/hardware', this.hardware());
        }

        const res = await this.call('POST', '/stats', {
          miner: { status: this.miner, uptime_sec: this.minerStartedAt && this.miner !== 'stopped' ? Math.round((Date.now() - this.minerStartedAt) / 1000) : 0 },
          system: { cpu_load: Number(jitter(0.4, 0.5).toFixed(2)), ram_used_mb: Math.round(jitter(1350, 0.05)) },
          gpus: this.sample(),
        });
        if (res.hardware_required) await this.call('PUT', '/hardware', this.hardware());
        if (res.config_version !== this.configVersion) await this.applyConfig();
        if (res.pending_commands > 0) await this.runCommands();
      } catch (err) {
        if (err.status === 401 && CONF) {
          this.log('rig.conf geçersiz (panelden yeniden oluşturulmuş olabilir). Yeni dosya bekleniyor…');
          this.paired = false;
          await sleep(15000);
          try { this.loadConf(); } catch (e) { this.log(e.message); }
          continue;
        }
        if (err.status === 401) { this.log('Kimlik geçersiz (rig panelden silinmiş olabilir) → yeniden kayıt'); this.creds = null; this.paired = false; this.hwSent = false; delete saved[this.key]; save(); continue; }
        this.log('Hata:', err.message);
      }
      await sleep(INTERVAL);
    }
  }
}

console.log(`Simülatör: ${API} · rig'ler: ${which.join(', ')} · aralık ${INTERVAL / 1000} sn${CONF ? ` · rig.conf: ${CONF}` : ''}`);
for (const n of which) new FakeRig(n).loop();
