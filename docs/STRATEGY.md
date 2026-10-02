# Estratégia v0 — momentum de segunda onda

Tudo aqui são **hipóteses iniciais** a serem testadas. Valores ficam em `config/strategy.v0.yaml`, nunca no código.
Mudou uma regra? Crie uma nova versão (`v1`, `v2`...) e registre abaixo o motivo e o resultado do backtest.

## 1. Tese

Os primeiros segundos pertencem a snipers profissionais e insiders. A estratégia não disputa esse momento: espera o token **sobreviver** aos primeiros minutos, descarta os que mostram sinais de manipulação e entra só quando há compra aparentemente orgânica. O ganho vem de **evitar lixo** e **sair rápido**, não de acertar o 100x.

## 2. Universo

- **Por enquanto, só tokens ainda na bonding curve** (`filters.allowedVenues: [curve]`). Tokens recém-graduados
  no PumpSwap ficam de fora do universo de entrada. O pré-requisito técnico — a matemática do swap do PumpSwap
  bater exato — foi cumprido em 2026-10-02 (ver `docs/ROADMAP.md` Fase 2, tarefa "Resolver swap exato do
  PumpSwap"); incluir graduados continua sendo **decisão do usuário** e ainda exige gravar
  `virtual_quote_reserves` por trade no ingest/estado. Custo de ida e volta medido no PumpSwap (0,1 SOL,
  quote WSOL): ~2,2–2,5% (≈ 218–247 bps conforme o tier de taxa), contra ~2,5% na curva (2 × 125 bps).
  - Se uma posição aberta na curva **graduar para o PumpSwap enquanto está aberta**, o paper executor fecha a
    posição no último preço conhecido da bonding curve (não simula venda no PumpSwap) e marca o fill com
    `venue_unverified: true`. Enquanto o universo for só curva, qualquer tentativa de simular um swap no
    PumpSwap deve lançar erro explícito (`PumpSwapSimulationNotValidatedError`), nunca aproximar silenciosamente.
- Idade entre `entry.minAgeSec` (60) e `entry.maxAgeSec` (600).
- Quote mint permitido: só SOL (`filters.allowedQuoteMints`) — placeholder nativo da curva (`11111111111111111111111111111111`) e WSOL (`So11111111111111111111111111111111111111112`). Outros quote mints são rejeitados.

## 3. Filtros duros (qualquer um falha → `reject`)

| Filtro | Valor inicial |
|---|---|
| % do supply no top 10 holders (excluindo curva/pool) | ≤ 30% |
| % do supply comprado no slot de criação por carteiras **diferentes do criador** (proxy de bundle; v0.1) | ≤ 10% |
| Criador ainda segura (inclui a compra inicial, medida à parte como `creatorInitialBuyPct` no snapshot) | ≤ 5% |
| Criador criou ≥ 3 tokens nas últimas 24h | rejeita |
| Holders únicos | ≥ 40 |
| Volume últimos 60 s | ≥ 5 SOL |
| Score do modelo de risco (quando existir) | ≤ 0,3 |

## 4. Gatilho de entrada (todos verdadeiros)

- Razão buy/sell em volume nos últimos 60 s ≥ 1,5.
- Compradores únicos nos últimos 60 s ≥ 15.
- Preço acima da média dos últimos 120 s.
- Nenhuma venda individual > 3% do supply nos últimos 60 s.
- (Fase 5) Opcional: narrativa com `matchesNarrative ≥ 0,7` **ou** ≥ 2 smart wallets comprando reduz o requisito de compradores únicos.

## 5. Tamanho

- Valor fixo por operação: `sizing.sizeSol` = **0,05 SOL** (paper e live inicial), total pago à curva já com as
  taxas da curva (priority fee, tip e rent são custos à parte). Era 0,1 SOL fictício no paper; reduzido em
  2026-10-01 (Fase 3/parte B) porque o hard limit `maxPositionLamports` (0,05 SOL, `packages/risk/src/hard-limits.ts`)
  vale também no paper — assim o paper mede o que o live faria. A config só pode reduzir esse valor; acima dele
  o bot não sobe (erro explícito).
- Impacto de preço estimado da própria compra ≤ 2% (`sizing.maxOwnPriceImpactPct`), medido como preço médio de
  execução (sem taxas) ÷ preço marginal antes da compra − 1. Se maior, reduz o tamanho (busca binária) até caber;
  se o tamanho que cabe ficar abaixo de 50% do valor fixo, rejeita (os custos fixos por transação não encolhem).

## 6. Saídas (a primeira que acontecer)

| Regra | Valor inicial |
|---|---|
| Take profit 1 | +40% → vende 50% |
| Take profit 2 | +100% → vende mais 30% |
| Trailing stop no restante | −25% a partir da máxima |
| Stop loss | −20% |
| Time stop | 10 min sem atingir TP1 → vende tudo |
| Saída de emergência | venda individual > 5% do supply ou criador vendendo → vende tudo |

Todos os percentuais são **líquidos de taxas estimadas de saída**:
`pnl = (realizadoLíquido + L − custoEntrada) / custoEntrada`, com `custoEntrada` = SOL pago à curva (com taxas) +
priority fee + tip + rent da compra, e `L` = líquido de vender o restante agora (`bondingCurveSell`, já sem as taxas
da curva) − priority fee − tip estimados da saída + rent devolvido ao fechar a conta.

Detalhes de implementação (`packages/positions`): `sellFraction` dos take profits é fração da quantidade
**inicial** (50% + 30% → sobram 20%); o trailing só vale depois do TP1 e mede o valor líquido do restante (a
máxima recomeça após cada venda parcial); emergência considera só trades com `ts` posterior à entrada. Se várias
regras disparam no mesmo instante, vale a primeira em: graduação > criador vendendo > venda > 5% do supply >
stop loss > trailing > time stop > take profit. Graduação (curva completou / migrou) fecha tudo no último preço da
curva (§2).

## 7. Métrica de sucesso

Para a v0, o critério de sucesso é avaliado **em paper trading** (o backtest fora da amostra passa a valer
critério quando a Fase 4 do `docs/ROADMAP.md` existir):
- ≥ 200 operações.
- PnL líquido > 0 depois de **todas** as taxas, tips, rent e slippage simulados.
- Continua positivo mesmo removendo as 3 melhores operações.
- Drawdown máximo ≤ 30% do capital alocado.

## 8. Registro de versões

| Versão | Data | Mudança | Resultado (backtest fora da amostra) |
|---|---|---|---|
| v0 | — | versão inicial | — |
| v0.1 | 2026-10-01 | `maxSameSlotAsCreatePct` passa a ignorar as compras do criador no slot de criação (proxy de bundle = só outras carteiras); a compra inicial do criador vira a feature informativa `creatorInitialBuyPct` e continua coberta por `maxCreatorHoldingPct`. Motivo: no paper de 01/10, o criador comprou na mesma tx do create em 693 de 956 tokens (72%; mediana 0,5% do supply, p90 6,7%). Limites inalterados. Efeito medido: dos 331 tokens acima de 10% no slot, 286 continuam acima só com outras carteiras (o filtro muda para 45 tokens). | ainda sem backtest (Fase 4 condicional) — avaliar no paper |
