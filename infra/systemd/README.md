# systemd — `pnpm bot --mode=record`

Pré-requisitos na VPS (Ubuntu 24.04): Node.js 22, pnpm em `/usr/local/bin` ou `/usr/bin`, Docker.

```bash
# 1. usuário dedicado, sem sudo e sem shell de login
sudo useradd --system --create-home --home-dir /opt/memebot --shell /usr/sbin/nologin memebot

# 2. código + dependências (como memebot)
sudo -u memebot git clone <repo> /opt/memebot     # ou rsync
cd /opt/memebot && sudo -u memebot pnpm install --frozen-lockfile
sudo -u memebot mkdir -p data

# 3. .env só legível pelo memebot
sudo -u memebot cp .env.example .env && sudo chmod 600 .env   # edite RPC_URL, RPC_WS_URL, CLICKHOUSE_PASSWORD...

# 4. banco
sudo docker compose up -d && sudo -u memebot pnpm migrate

# 5. conferência manual antes de ligar o serviço: 20 eventos com link do Solscan
sudo -u memebot pnpm bot --mode=record --debug-events=20

# 6. serviço
sudo cp infra/systemd/memebot-record.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now memebot-record
```

Verificação:

```bash
systemctl status memebot-record
journalctl -u memebot-record -f          # a cada minuto: eventsPerMin, gapsPerMin, writer
sudo -u memebot pnpm sanity --hours=1    # depois de 24 h: --hours=24 (aceite da Fase 1)
systemd-analyze security memebot-record  # nota do hardening
```

Parada: `sudo systemctl stop memebot-record` envia SIGTERM; o bot fecha o WebSocket e grava o
buffer pendente (até 30 s, `TimeoutStopSec`).
