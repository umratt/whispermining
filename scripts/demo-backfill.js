'use strict';
// Sadece geliştirme/demo için: eşleşmiş rig'lere son 24 saatin 5 dakikalık özet verisini yazar,
// böylece grafikler simülatörün 24 saat çalışmasını beklemeden görülebilir.
// Kullanım: npm run demo-backfill
const { all, run, tx, now } = require('../server/db');

if (process.env.NODE_ENV === 'production') {
  console.error('Bu betik üretimde çalıştırılmaz.');
  process.exit(1);
}

const end = Math.floor(now() / 300) * 300 - 900; // canlı veriyle çakışmasın
const start = end - 24 * 3600;
let rows = 0;

tx(() => {
  for (const rig of all('SELECT id, name FROM rigs WHERE owner_id IS NOT NULL')) {
    const gpus = all('SELECT id, vendor, model, hashrate, power, temp FROM gpus WHERE rig_id = ? AND present = 1', rig.id);
    if (!gpus.length) continue;
    const outageAt = start + Math.floor(Math.random() * 20 + 2) * 3600; // 24 saat içinde bir kısa kesinti
    for (let b = start; b < end; b += 300) {
      const outage = b >= outageAt && b < outageAt + 1500;
      let H = 0; let P = 0; let T = null;
      for (const g of gpus) {
        const baseH = g.hashrate || (g.model.includes('3080') ? 96e6 : g.vendor === 'amd' ? 30e6 : 21e6);
        const baseP = g.power || (g.model.includes('3080') ? 228 : g.vendor === 'amd' ? 118 : 82);
        const daily = Math.sin(((b % 86400) / 86400) * Math.PI * 2 - 1.2); // gündüz biraz daha sıcak
        const h = outage ? 0 : baseH * (1 + (Math.random() - 0.5) * 0.04);
        const p = outage ? baseP * 0.1 : baseP * (1 + (Math.random() - 0.5) * 0.05);
        const t = outage ? 38 : (g.temp || 60) + daily * 4 + (Math.random() - 0.5) * 2;
        const fan = Math.min(100, Math.max(30, 30 + (t - 45) * 2.2));
        run('INSERT OR REPLACE INTO gpu_stats_5m (bucket, gpu_id, hashrate, temp, temp_max, fan, power) VALUES (?,?,?,?,?,?,?)', b, g.id, h, t, t + 1, fan, p);
        H += h; P += p; T = Math.max(T ?? 0, t + 1);
        rows++;
      }
      run('INSERT OR REPLACE INTO rig_stats_5m (bucket, rig_id, hashrate, power, temp_max) VALUES (?,?,?,?,?)', b, rig.id, H, P, T);
    }
    console.log(`${rig.name}: ${gpus.length} kart için 24 saat yazıldı`);
  }
});
console.log(`Toplam ${rows} kart-kova satırı.`);
