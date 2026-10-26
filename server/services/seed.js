'use strict';
const { get, run, tx, now } = require('../db');

// Miner kataloğu. SHA256 değerleri resmî GitHub sürüm dosyalarından alındı (Ekim 2026):
//  - lolMiner, SRBMiner-Multi, Rigel, BzMiner: GitHub'ın yayınladığı SHA256 ile eşleşti
//  - TeamRedMiner: arşivdeki programın SHA256'sı sürüm notundakiyle eşleşti
//  - T-Rex, GMiner: resmî değer yayınlanmıyor; resmî sürüm dosyasından hesaplandı
// Var olan kayıtlar silinmez/değiştirilmez; sadece eksik miner/sürüm eklenir ve boş SHA256 doldurulur.
const CATALOG = [
  {
    name: 'T-Rex', api_type: 'trex', nvidia: 1, amd: 0, notes: 'Sadece NVIDIA. P106-100 ve RTX 3080 için uygun.',
    versions: [{ version: '0.26.8', url: 'https://github.com/trexminer/T-Rex/releases/download/0.26.8/t-rex-0.26.8-linux.tar.gz',
      sha256: '7e77064a48b4c8cb8d4797f30a41b53efbb8311fc14475b56a8e6879ad1c0569', algos: 'etchash,kawpow,autolykos2,octopus,firopow', default: true }],
  },
  {
    name: 'lolMiner', api_type: 'lolminer', nvidia: 1, amd: 1, notes: 'AMD + NVIDIA. Karışık rig\'ler ve RX 580 (ROCm) için önerilen.',
    versions: [
      { version: '1.98', url: 'https://github.com/Lolliedieb/lolMiner-releases/releases/download/1.98/lolMiner_v1.98_Lin64.tar.gz',
        sha256: '', algos: 'etchash,autolykos2,equihash125_4,beamhash,kaspa,alephium' },
      { version: '1.98a', url: 'https://github.com/Lolliedieb/lolMiner-releases/releases/download/1.98a/lolMiner_v1.98a_Lin64.tar.gz',
        sha256: '0b8078299654a12846e4967f1db3506409cfb8b1031687a910965d1a99c6f270', algos: 'etchash,autolykos2,equihash125_4,beamhash,alephium', default: true },
    ],
  },
  {
    name: 'TeamRedMiner', api_type: 'teamredminer', nvidia: 0, amd: 1, notes: 'Sadece AMD. ROCm ile Polaris\'te çalışması garanti değil.',
    versions: [{ version: '0.10.21', url: 'https://github.com/todxx/teamredminer/releases/download/v0.10.21/teamredminer-v0.10.21-linux.tgz',
      sha256: '3d5987bba0125150cbb47c49b5929ea579dca1ac3cae4b7a70e96c2c5f843836', algos: 'etchash,kawpow,autolykos2,firopow', default: true }],
  },
  {
    name: 'SRBMiner-Multi', api_type: 'srbminer', nvidia: 1, amd: 1, notes: 'AMD + NVIDIA, çok algoritma. RX 580 için ikinci seçenek.',
    versions: [{ version: '3.8.0', url: 'https://github.com/doktor83/SRBMiner-Multi/releases/download/3.8.0/SRBMiner-Multi-3-8-0-Linux.tar.gz',
      sha256: '095c3f75905ee023e8ed85ac905afefc92825cce83a528fa955cf1db456d3dd8', algos: 'etchash,kawpow,autolykos2,firopow,alephium,kaspa', default: true }],
  },
  {
    name: 'GMiner', api_type: 'gminer', nvidia: 1, amd: 1, notes: 'Ağırlıklı NVIDIA. P106 için etchash/kawpow.',
    versions: [{ version: '3.44', url: 'https://github.com/develsoftware/GMinerRelease/releases/download/3.44/gminer_3_44_linux64.tar.xz',
      sha256: 'b7d2dc6b338dfc6c9e292fbbd6612e512d9cdc9fe7b9cf62f20ccfc77d2e7dbb', algos: 'etchash,kawpow,autolykos2,octopus,firopow,beamhash,equihash125_4', default: true }],
  },
  {
    name: 'Rigel', api_type: 'rigel', nvidia: 1, amd: 0, notes: 'Sadece NVIDIA. İstatistik okuma gerçek rig\'de doğrulanacak.',
    versions: [{ version: '1.23.2', url: 'https://github.com/rigelminer/rigel/releases/download/1.23.2/rigel-1.23.2-linux.tar.gz',
      sha256: 'eae492ffb64aeb4ab4ba7e66631567984a31d5adb1ef547bda6601aee1793f0d', algos: 'etchash,kawpow,autolykos2,octopus,alephium', default: true }],
  },
  {
    name: 'BzMiner', api_type: 'bzminer', nvidia: 1, amd: 1, notes: 'AMD + NVIDIA. İstatistik okuma gerçek rig\'de doğrulanacak.',
    versions: [{ version: '100.51', url: 'https://github.com/bzminer/bzminer/releases/download/v100.51/bzminer_v100.51_linux.tar.gz',
      sha256: 'dc2001f4bdcee6892b5a9cb8c96a44ddc12d17755fed360eca8917d0d2535ce5', algos: 'etchash,kawpow,autolykos2,alephium,octopus', default: true }],
  },
];

function seedCatalog() {
  tx(() => {
    for (const m of CATALOG) {
      let miner = get('SELECT id FROM miners WHERE api_type = ?', m.api_type);
      if (!miner) {
        const r = run('INSERT INTO miners (name, api_type, supports_nvidia, supports_amd, notes) VALUES (?,?,?,?,?)',
          m.name, m.api_type, m.nvidia, m.amd, m.notes);
        miner = { id: Number(r.lastInsertRowid) };
      }
      for (const v of m.versions) {
        const existing = get('SELECT id, sha256, download_url FROM miner_versions WHERE miner_id = ? AND version = ?', miner.id, v.version);
        if (!existing) {
          if (v.default) run('UPDATE miner_versions SET is_default = 0 WHERE miner_id = ?', miner.id);
          run(`INSERT INTO miner_versions (miner_id, version, download_url, sha256, algos, is_default, created_at)
               VALUES (?,?,?,?,?,?,?)`, miner.id, v.version, v.url, v.sha256, v.algos, v.default ? 1 : 0, now());
        } else if (!existing.sha256 && v.sha256 && existing.download_url === v.url) {
          // Daha önce SHA'sız eklenmiş aynı resmî dosya: doğrulanmış SHA'yı yaz (adresi değiştirilmişse dokunma)
          run('UPDATE miner_versions SET sha256 = ? WHERE id = ?', v.sha256, existing.id);
          run(`UPDATE rigs SET config_version = config_version + 1 WHERE flight_sheet_id IN
               (SELECT flight_sheet_id FROM flight_sheet_miners WHERE miner_version_id = ?)`, existing.id);
        }
      }
    }
  });
}

module.exports = { seedCatalog };
