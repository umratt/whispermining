'use strict';
const { all, run, tx, now } = require('../db');
const config = require('../config');

const num = (v, min = -1e15, max = 1e15) => {
  if (v === null || v === undefined || v === '') return null; // Number(null) = 0 olurdu
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};
const int = (v, min, max) => { const n = num(v, min, max); return n === null ? null : Math.round(n); };

const MINER_STATUSES = new Set(['running', 'stopped', 'starting', 'error', 'downloading', 'unknown']);

// Agent'ın periyodik istatistik paketini kaydet
function ingestStats(rig, body) {
  const t = now();
  const gpusByBus = new Map(all('SELECT id, bus_id FROM gpus WHERE rig_id = ?', rig.id).map((g) => [g.bus_id, g.id]));
  const miner = body.miner || {};
  const system = body.system || {};
  let unknown = 0;
  const totals = { hashrate: 0, power: 0, temp_max: null, accepted: 0, rejected: 0 };

  tx(() => {
    for (const g of Array.isArray(body.gpus) ? body.gpus.slice(0, 32) : []) {
      const gpuId = gpusByBus.get(String(g.bus_id));
      if (!gpuId) { unknown++; continue; }
      const s = {
        hashrate: num(g.hashrate, 0), temp: num(g.temp, -50, 150), mem_temp: num(g.mem_temp, -50, 150),
        fan: num(g.fan, 0, 100), power: num(g.power, 0, 1000), core_clk: int(g.core_clk, 0, 5000),
        mem_clk: int(g.mem_clk, 0, 20000), accepted: int(g.accepted, 0, 1e12), rejected: int(g.rejected, 0, 1e12),
      };
      run(`INSERT INTO gpu_stats (ts, gpu_id, hashrate, temp, mem_temp, fan, power, core_clk, mem_clk, accepted, rejected)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`, t, gpuId, s.hashrate, s.temp, s.mem_temp, s.fan, s.power, s.core_clk,
      s.mem_clk, s.accepted, s.rejected);
      run(`UPDATE gpus SET hashrate=?, temp=?, mem_temp=?, fan=?, power=?, core_clk=?, mem_clk=?, accepted=?, rejected=?,
           stats_at=? WHERE id=?`, s.hashrate, s.temp, s.mem_temp, s.fan, s.power, s.core_clk, s.mem_clk, s.accepted,
      s.rejected, t, gpuId);
      totals.hashrate += s.hashrate || 0;
      totals.power += s.power || 0;
      if (s.temp !== null) totals.temp_max = Math.max(totals.temp_max ?? -100, s.temp);
      totals.accepted += s.accepted || 0;
      totals.rejected += s.rejected || 0;
    }
    run(`INSERT INTO rig_stats (ts, rig_id, hashrate, power, temp_max, accepted, rejected, cpu_load)
         VALUES (?,?,?,?,?,?,?,?)`, t, rig.id, totals.hashrate, totals.power, totals.temp_max, totals.accepted,
    totals.rejected, num(system.cpu_load, 0, 1000));
    const status = MINER_STATUSES.has(miner.status) ? miner.status : 'unknown';
    run(`UPDATE rigs SET miner_status=?, miner_uptime_sec=?, cpu_load=?, ram_used_mb=?, miner_error=? WHERE id=?`,
      status, int(miner.uptime_sec, 0, 1e9), num(system.cpu_load, 0, 1000), int(system.ram_used_mb, 0, 1e7),
      miner.error ? String(miner.error).slice(0, 500) : null, rig.id);
  });
  return { unknownGpus: unknown };
}

// Ham veriyi 5 dakikalık kovalara topla (son 15 dakikayı yeniden hesaplar)
function rollup() {
  const from = Math.floor((now() - 900) / 300) * 300;
  tx(() => {
    run(`INSERT OR REPLACE INTO gpu_stats_5m (bucket, gpu_id, hashrate, temp, temp_max, fan, power)
         SELECT (ts / 300) * 300 AS b, gpu_id, AVG(hashrate), AVG(temp), MAX(temp), AVG(fan), AVG(power)
         FROM gpu_stats WHERE ts >= ? GROUP BY gpu_id, b`, from);
    run(`INSERT OR REPLACE INTO rig_stats_5m (bucket, rig_id, hashrate, power, temp_max)
         SELECT (ts / 300) * 300 AS b, rig_id, AVG(hashrate), AVG(power), MAX(temp_max)
         FROM rig_stats WHERE ts >= ? GROUP BY rig_id, b`, from);
  });
}

function purge() {
  const t = now();
  run('DELETE FROM gpu_stats WHERE ts < ?', t - config.rawRetentionSec);
  run('DELETE FROM rig_stats WHERE ts < ?', t - config.rawRetentionSec);
  run('DELETE FROM gpu_stats_5m WHERE bucket < ?', t - config.rollupRetentionSec);
  run('DELETE FROM rig_stats_5m WHERE bucket < ?', t - config.rollupRetentionSec);
  run('DELETE FROM sessions WHERE expires_at < ?', t);
  run(`DELETE FROM commands WHERE created_at < ? AND status IN ('done','failed','expired')`, t - 30 * 86400);
  run('DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?', t - 30 * 86400);
}

module.exports = { ingestStats, rollup, purge };
