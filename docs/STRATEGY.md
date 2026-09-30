# Estratégia v0 — momentum de segunda onda

Tudo aqui são **hipóteses iniciais** a serem testadas. Valores ficam em `config/strategy.v0.yaml`, nunca no código.
Mudou uma regra? Crie uma nova versão (`v1`, `v2`...) e registre abaixo o motivo e o resultado do backtest.

## 1. Tese

Os primeiros segundos pertencem a snipers profissionais e insiders. A estratégia não disputa esse momento: espera o token **sobreviver** aos primeiros minutos, descarta os que mostram sinais de manipulação e entra só quando há compra aparentemente orgânica. O ganho vem de **evitar lixo** e **sair rápido**, não de acertar o 100x.

## 2. Universo

- Tokens do Pump.fun ainda na bonding curve **ou** recém-graduados no PumpSwap.
- Idade entre `entry.minAgeSec` (60) e `entry.maxAgeSec` (600).

## 3. Filtros duros (qualquer um falha → `reject`)

| Filtro | Valor inicial |
|---|---|
| % do supply no top 10 holders (excluindo curva/pool) | ≤ 30% |
| % comprado no mesmo slot da criação (proxy de bundle) | ≤ 10% |
| Criador ainda segura | ≤ 5% |
| Criador com ≥ 3 tokens anteriores que "ruguaram" | rejeita |
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

- Valor fixo por operação: `risk.sizeLamports` (paper: 0,1 SOL fictício; live inicial: o mínimo de `hard-limits.ts`).
- Impacto de preço estimado da própria compra ≤ 2%; se maior, reduz o tamanho ou rejeita.

## 6. Saídas (a primeira que acontecer)

| Regra | Valor inicial |
|---|---|
| Take profit 1 | +40% → vende 50% |
| Take profit 2 | +100% → vende mais 30% |
| Trailing stop no restante | −25% a partir da máxima |
| Stop loss | −20% |
| Time stop | 10 min sem atingir TP1 → vende tudo |
| Saída de emergência | venda individual > 5% do supply ou criador vendendo → vende tudo |

Todos os percentuais são **líquidos de taxas estimadas de saída**.

## 7. Métrica de sucesso

A estratégia só avança se, no período fora da amostra:
- PnL líquido > 0 depois de **todas** as taxas, tips, rent e slippage simulados.
- Expectativa por operação > 0 com intervalo de confiança (bootstrap) que não cruze zero de forma relevante.
- Drawdown máximo ≤ 30% do capital alocado.
- Resultado não depende de 1 ou 2 operações extremas (testar removendo as 3 melhores).

## 8. Registro de versões

| Versão | Data | Mudança | Resultado (backtest fora da amostra) |
|---|---|---|---|
| v0 | — | versão inicial | — |
