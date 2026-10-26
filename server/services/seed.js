'use strict';
const { get, run, tx, now } = require('../db');

// İlk kurulumda miner kataloğunu doldurur. SHA256 alanları bilerek boş bırakıldı:
// yönetici resmi sürüm sayfasından hash'i doğrulayıp girmeden agent indirme yapmaz.
const CATALOG = [
  {
    name: 'T-Rex', api_type: 'trex', nvidia: 1, amd: 0, notes: 'Sadece NVIDIA. P106-100 ve RTX 3080 için uygun.',
    versions: [{ version: '0.26.8', url: 'https://github.com/trexminer/T-Rex/releases/download/0.26.8/t-rex-0.26.8-linux.tar.gz',
      algos: 'etchash,kawpow,autolykos2,octopus,firopow' }],
  },
  {
    name: 'lolMiner', api_type: 'lolminer', nvidia: 1, amd: 1, notes: 'AMD + NVIDIA. Karışık rig\'ler için tek miner seçeneği.',
    versions: [{ version: '1.98', url: 'https://github.com/Lolliedieb/lolMiner-releases/releases/download/1.98/lolMiner_v1.98_Lin64.tar.gz',
      algos: 'etchash,autolykos2,equihash125_4,beamhash,kaspa,alephium' }],
  },
  {
    name: 'TeamRedMiner', api_type: 'teamredminer', nvidia: 0, amd: 1, notes: 'Sadece AMD. RX 580 (Polaris) için uygun.',
    versions: [{ version: '0.10.21', url: 'https://github.com/todxx/teamredminer/releases/download/v0.10.21/teamredminer-v0.10.21-linux.tgz',
      algos: 'etchash,kawpow,autolykos2,firopow' }],
  },
];

function seedCatalog() {
  if (get('SELECT COUNT(*) AS n FROM miners').n > 0) return;
  tx(() => {
    for (const m of CATALOG) {
      const r = run('INSERT INTO miners (name, api_type, supports_nvidia, supports_amd, notes) VALUES (?,?,?,?,?)',
        m.name, m.api_type, m.nvidia, m.amd, m.notes);
      for (const v of m.versions) {
        run(`INSERT INTO miner_versions (miner_id, version, download_url, sha256, algos, is_default, created_at)
             VALUES (?,?,?,?,?,1,?)`, r.lastInsertRowid, v.version, v.url, '', v.algos, now());
      }
    }
  });
}

module.exports = { seedCatalog };
