'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

// Şema sürümleri: yeni değişiklik eklenecekse diziye yeni eleman ekle, eskileri değiştirme.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    telegram_chat_id TEXT,
    temp_limit INTEGER NOT NULL DEFAULT 80,
    hashrate_drop_pct INTEGER NOT NULL DEFAULT 20,
    offline_after_sec INTEGER NOT NULL DEFAULT 120,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,               -- token'ın sha256 hash'i
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT, user_agent TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE wallets (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    coin TEXT NOT NULL,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE miners (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    api_type TEXT NOT NULL,            -- trex, lolminer, teamredminer ...
    supports_nvidia INTEGER NOT NULL DEFAULT 0,
    supports_amd INTEGER NOT NULL DEFAULT 0,
    notes TEXT
  );

  CREATE TABLE miner_versions (
    id INTEGER PRIMARY KEY,
    miner_id INTEGER NOT NULL REFERENCES miners(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    download_url TEXT NOT NULL,
    sha256 TEXT NOT NULL DEFAULT '',
    algos TEXT NOT NULL DEFAULT '',    -- virgülle ayrılmış
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (miner_id, version)
  );

  CREATE TABLE flight_sheets (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    coin TEXT NOT NULL,
    algo TEXT NOT NULL,
    wallet_id INTEGER REFERENCES wallets(id) ON DELETE SET NULL,
    pools TEXT NOT NULL DEFAULT '[]',  -- JSON: ["stratum+tcp://..", ...]
    worker_template TEXT NOT NULL DEFAULT '%RIG_NAME%',
    pool_pass TEXT NOT NULL DEFAULT 'x',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE flight_sheet_miners (
    id INTEGER PRIMARY KEY,
    flight_sheet_id INTEGER NOT NULL REFERENCES flight_sheets(id) ON DELETE CASCADE,
    miner_version_id INTEGER NOT NULL REFERENCES miner_versions(id),
    gpu_vendor TEXT NOT NULL DEFAULT 'all',  -- all | nvidia | amd
    extra_args TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE oc_profiles (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    vendor TEXT NOT NULL,              -- nvidia | amd
    params TEXT NOT NULL DEFAULT '{}', -- JSON
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE rigs (
    id TEXT PRIMARY KEY,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    pairing_code TEXT,
    pairing_expires_at INTEGER,
    hw_fingerprint TEXT,
    hostname TEXT,
    agent_version TEXT,
    os_info TEXT,
    cpu_model TEXT,
    ram_total_mb INTEGER,
    last_ip TEXT,
    last_seen_at INTEGER,
    miner_status TEXT NOT NULL DEFAULT 'unknown',  -- running | stopped | starting | error | unknown
    miner_uptime_sec INTEGER,
    cpu_load REAL,
    ram_used_mb INTEGER,
    flight_sheet_id INTEGER REFERENCES flight_sheets(id) ON DELETE SET NULL,
    oc_nvidia_id INTEGER REFERENCES oc_profiles(id) ON DELETE SET NULL,
    oc_amd_id INTEGER REFERENCES oc_profiles(id) ON DELETE SET NULL,
    config_version INTEGER NOT NULL DEFAULT 1,
    paired_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX rigs_pairing_code ON rigs(pairing_code) WHERE pairing_code IS NOT NULL;
  CREATE INDEX rigs_owner ON rigs(owner_id);

  CREATE TABLE gpus (
    id INTEGER PRIMARY KEY,
    rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
    bus_id TEXT NOT NULL,              -- PCI adresi: kartın kalıcı kimliği
    idx INTEGER NOT NULL,
    vendor TEXT NOT NULL,
    model TEXT NOT NULL,
    vram_mb INTEGER,
    driver TEXT,
    vbios TEXT,
    uuid TEXT,
    present INTEGER NOT NULL DEFAULT 1,
    oc_profile_id INTEGER REFERENCES oc_profiles(id) ON DELETE SET NULL,
    -- son istatistik (liste ekranları hızlı olsun diye)
    hashrate REAL, temp REAL, mem_temp REAL, fan REAL, power REAL,
    core_clk INTEGER, mem_clk INTEGER, accepted INTEGER, rejected INTEGER,
    stats_at INTEGER,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    UNIQUE (rig_id, bus_id)
  );

  CREATE TABLE gpu_stats (
    ts INTEGER NOT NULL,
    gpu_id INTEGER NOT NULL REFERENCES gpus(id) ON DELETE CASCADE,
    hashrate REAL, temp REAL, mem_temp REAL, fan REAL, power REAL,
    core_clk INTEGER, mem_clk INTEGER, accepted INTEGER, rejected INTEGER
  );
  CREATE INDEX gpu_stats_gpu_ts ON gpu_stats(gpu_id, ts);
  CREATE INDEX gpu_stats_ts ON gpu_stats(ts);

  CREATE TABLE rig_stats (
    ts INTEGER NOT NULL,
    rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
    hashrate REAL, power REAL, temp_max REAL,
    accepted INTEGER, rejected INTEGER, cpu_load REAL
  );
  CREATE INDEX rig_stats_rig_ts ON rig_stats(rig_id, ts);
  CREATE INDEX rig_stats_ts ON rig_stats(ts);

  CREATE TABLE gpu_stats_5m (
    bucket INTEGER NOT NULL,
    gpu_id INTEGER NOT NULL REFERENCES gpus(id) ON DELETE CASCADE,
    hashrate REAL, temp REAL, temp_max REAL, fan REAL, power REAL,
    PRIMARY KEY (gpu_id, bucket)
  ) WITHOUT ROWID;

  CREATE TABLE rig_stats_5m (
    bucket INTEGER NOT NULL,
    rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
    hashrate REAL, power REAL, temp_max REAL,
    PRIMARY KEY (rig_id, bucket)
  ) WITHOUT ROWID;

  CREATE TABLE commands (
    id INTEGER PRIMARY KEY,
    rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued', -- queued | sent | done | failed | expired
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    finished_at INTEGER,
    exit_code INTEGER,
    result TEXT
  );
  CREATE INDEX commands_rig_status ON commands(rig_id, status);

  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY,
    rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
    gpu_id INTEGER REFERENCES gpus(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                -- offline | gpu_lost | high_temp | hashrate_drop (v2: hw_changed)
    severity TEXT NOT NULL,            -- warning | critical
    message TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    resolved_at INTEGER,
    notified_at INTEGER
  );
  CREATE INDEX alerts_open ON alerts(rig_id, type, resolved_at);

  CREATE TABLE agent_releases (
    id INTEGER PRIMARY KEY,
    version TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'stable',
    download_url TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    notes TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (version, channel)
  );
  `,
  // v2: rig.conf ile kurulum — aynı dosya farklı donanımda kullanılırsa uyarı için
  `
  ALTER TABLE rigs ADD COLUMN hw_changed_at INTEGER;
  `,
  // v3: flash belleğe yazılacak Ubuntu imajları (Kurulum sayfasında indirilir)
  `
  CREATE TABLE os_images (
    id INTEGER PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    download_url TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_mb INTEGER,
    notes TEXT,
    created_at INTEGER NOT NULL
  );
  `,
  // v4: OC kart modeline göre atanır (P106 profili sonradan takılan RTX 3080'e uygulanmasın).
  // rigs.oc_nvidia_id / oc_amd_id artık kullanılmıyor; mevcut atamalar model bazına taşınır.
  `
  CREATE TABLE rig_oc (
    rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    oc_profile_id INTEGER NOT NULL REFERENCES oc_profiles(id) ON DELETE CASCADE,
    PRIMARY KEY (rig_id, model)
  ) WITHOUT ROWID;
  INSERT OR IGNORE INTO rig_oc (rig_id, model, oc_profile_id)
    SELECT DISTINCT g.rig_id, g.model, CASE g.vendor WHEN 'amd' THEN r.oc_amd_id ELSE r.oc_nvidia_id END
    FROM gpus g JOIN rigs r ON r.id = g.rig_id
    WHERE (CASE g.vendor WHEN 'amd' THEN r.oc_amd_id ELSE r.oc_nvidia_id END) IS NOT NULL;
  ALTER TABLE gpus ADD COLUMN is_new INTEGER NOT NULL DEFAULT 0;
  `,
  // v5: agent'ın bildirdiği son hata (monitörsüz rig'de sorunu panelde görmek için)
  `
  ALTER TABLE rigs ADD COLUMN miner_error TEXT;
  `,
  // v6: otomatik OC ayarının ilerlemesi ve sonucu (agent istatistikle gönderir)
  `
  ALTER TABLE rigs ADD COLUMN tune_state TEXT;
  `,
  // v7: her kartın kendine özel OC değerleri (aynı model kartlar bile farklı değer kaldırır)
  `
  ALTER TABLE gpus ADD COLUMN oc_params TEXT;
  `,
  // v8: rig.conf anahtarı şifreli saklanır (sahibi istediği zaman tekrar indirebilsin)
  `
  ALTER TABLE rigs ADD COLUMN secret_enc TEXT;
  `,
];

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const stmtCache = new Map();
function q(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const get = (sql, ...p) => q(sql).get(...p);
const all = (sql, ...p) => q(sql).all(...p);
const run = (sql, ...p) => q(sql).run(...p);
const now = () => Math.floor(Date.now() / 1000);

migrate();

module.exports = { db, tx, get, all, run, now };
