# Risco e segurança

## 1. Chaves e carteiras

- **Duas carteiras, no mínimo:**
  - *Cofre*: onde fica o capital. Nunca vai para a VPS.
  - *Quente*: usada pelo bot. Saldo máximo = `hardLimits.maxHotWalletLamports`. Reabastecida manualmente.
- Keypair da quente em `secrets/hot.keypair.json`, permissão `600`, dono = usuário do serviço do bot.
- Nunca colar a chave em chat, prompt de IA, issue ou log. O Claude Code **não deve** abrir esse arquivo.
- Se houver qualquer suspeita de vazamento: transferir o saldo da quente para o cofre e gerar nova keypair.

## 2. Limites rígidos (`packages/risk/src/hard-limits.ts`)

Constantes no código; a config só pode reduzir. Valores iniciais sugeridos:

```ts
export const HARD_LIMITS = {
  maxPositionLamports: 50_000_000n,        // 0,05 SOL por operação
  maxOpenPositions: 3,
  maxDailyLossLamports: 200_000_000n,      // 0,2 SOL/dia → kill switch
  maxHotWalletLamports: 1_000_000_000n,    // 1 SOL
  maxSlippageBps: 1500,                    // 15%
  maxPriorityFeeLamports: 2_000_000n,
  maxJitoTipLamports: 2_000_000n,
} as const;
```

## 3. Kill switch

O bot para de abrir posições (e alerta no Telegram) se:
- perda do dia ≥ `maxDailyLossLamports`;
- 5 falhas de transação seguidas;
- stream sem eventos por 30 s;
- divergência entre saldo esperado e saldo on-chain > 1%;
- arquivo `data/STOP` existir (parada manual rápida).

Posições abertas continuam sendo gerenciadas para saída.

## 4. VPS

- Usuário dedicado sem sudo para o bot; login SSH só por chave; senha desativada; `ufw` liberando só SSH.
- Portas do ClickHouse **não** expostas à internet (bind em `127.0.0.1`).
- Atualizações automáticas de segurança (`unattended-upgrades`).
- Backup semanal dos dados em Parquet para fora da VPS (os dados são o ativo do projeto; as chaves **não** entram no backup).

## 5. Dependências

- Só pacotes populares do npm/PyPI, com versão travada (`pnpm-lock.yaml`, `uv.lock`).
- Nada de bots/SDKs "grátis" do GitHub ou de vendedores com promessa de lucro. Muitos roubam chaves.
- `pnpm audit` no `pnpm check`.

## 6. Riscos que o código não elimina

- Perda total do capital alocado é possível. Opere só com o que aceita perder.
- Mudanças de protocolo (taxas, instruções) podem quebrar o bot sem aviso. Por isso a config é lida on-chain e o parser valida tudo.
- Tributação: ganhos com criptoativos têm regras próprias na Receita Federal. Registre todas as operações (a tabela `fills` já serve de base) e consulte um contador.
- Este projeto não é recomendação de investimento.
