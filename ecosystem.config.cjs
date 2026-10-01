// pm2 — execução local do bot (enquanto não há VPS; lá o gerenciador é o systemd).
// Uso: ver README, seção "Rodar localmente com pm2".
// NUNCA rode memebot-record e memebot-paper ao mesmo tempo: o paper também grava os eventos de mercado
// (eventos duplicados). Inicie um só: `pm2 start ecosystem.config.cjs --only memebot-paper`.
const app = (mode) => ({
  name: `memebot-${mode}`,
  // node direto (não pnpm): no Windows o pm2 lida mal com o pnpm.cmd; a linha é a mesma do script "bot"
  script: 'apps/bot/src/main.ts',
  interpreter: 'node',
  node_args: '--experimental-strip-types --disable-warning=ExperimentalWarning',
  args: `--mode=${mode}`,
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
  out_file: `data/logs/memebot-${mode}.out.log`,
  error_file: `data/logs/memebot-${mode}.err.log`,
  merge_logs: true,
});

module.exports = {
  apps: [app('record'), app('paper')],
};
