// PM2 tanımı. Sistemdeki Node 20'ye (botlar) dokunmamak için bu uygulama kendi Node 22'si ile çalışır.
// Kurulum: pm2 start /opt/mining/app/deploy/ecosystem.config.js && pm2 save
module.exports = {
  apps: [{
    name: 'mining',
    cwd: '/opt/mining/app',
    script: 'server/index.js',
    interpreter: '/opt/mining/node/bin/node',
    node_args: '--disable-warning=ExperimentalWarning --max-old-space-size=160',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '220M', // sunucuda 2 GB RAM var; botlara yer kalsın
    autorestart: true,
    restart_delay: 3000,
    out_file: '/opt/mining/logs/out.log',
    error_file: '/opt/mining/logs/error.log',
    time: true,
  }],
};
