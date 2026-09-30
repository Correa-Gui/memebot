// pm2 — execução local de `pnpm bot --mode=record` (enquanto não há VPS; lá o gerenciador é o systemd).
// Uso: ver README, seção "Rodar localmente com pm2".
module.exports = {
  apps: [
    {
      name: 'memebot-record',
      // node direto (não pnpm): no Windows o pm2 lida mal com o pnpm.cmd; a linha é a mesma do script "bot"
      script: 'apps/bot/src/main.ts',
      interpreter: 'node',
      node_args: '--experimental-strip-types --disable-warning=ExperimentalWarning',
      args: '--mode=record',
      cwd: __dirname,
      // o bot lê o .env sozinho; nada de segredo aqui
      autorestart: true,
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      max_restarts: 1000,
      // parada limpa: no Windows não há SIGINT, então o pm2 manda a mensagem 'shutdown' por IPC
      shutdown_with_message: true,
      kill_timeout: 30000,
      time: true,
      out_file: 'data/logs/memebot-record.out.log',
      error_file: 'data/logs/memebot-record.err.log',
      merge_logs: true,
    },
  ],
};
