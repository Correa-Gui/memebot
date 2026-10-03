#!/usr/bin/env bash
# Verificação EM MASSA da matemática do PumpSwap (src/pumpswap.ts) contra TODOS os trades reais gravados
# que têm a linha lateral `pumpswap_trade_extra` (migração 011). Roda manualmente; não faz parte do check.
#
# Uso:  bash packages/curve-math/scripts/verify-pumpswap-bulk.sh > data/reports/pumpswap-bulk-verify.tsv
#
# Credenciais nunca passam por aqui: a query roda via `docker exec`, com as env vars do container.
# Fatias de 25 mil slots pela view parametrizada `v_pumpswap_trades` (o ClickHouse tem ~1,8 GiB).
# Reimplementa em SQL (Int256) as mesmas fórmulas de src/pumpswap.ts:
#   venda: bruto = floor(Qe·in/(B+in)); usuário = bruto − taxas
#   buy:   líquido = ceil(Qe·out/(B−out)); usuário paga líquido + taxas
#   buy_exact_quote_in: n0 = floor(q·10000/(10000+Σbps)); líquido = min(n0, q − taxas(n0));
#                       out = floor(B·(líquido−1)/(Qe+líquido−1))
#   taxas = ceil(valor·bps/10000) por componente; Qe = vault de quote + virtual_quote_reserves.
# Duas contagens: `ok_event_bps` usa o bps do criador do evento; `ok_rule` aplica a regra de pool sem
# criador (bps efetivo 0 quando creator_fee = 0 — equivalente exato a coin_creator = chave padrão, ver
# effectivePumpSwapFeeBps). Saída TSV: fatia, instrução, categoria, n, ok_event_bps, ok_rule, sigs que
# falham MESMO com a regra (deve ficar vazio).
q(){ docker exec -i memebot-clickhouse sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database memebot'; }
W=So11111111111111111111111111111111111111112
read -r from to < <(echo "SELECT min(slot), max(slot) + 1 FROM pumpswap_trade_extra FORMAT TSV" | q)
step=25000
for ((a=from; a<to; a+=step)); do b=$((a+step)); cat <<SQL | q
SELECT '$a' AS from_slot, instruction, cat, count() AS n, countIf(ok_raw) AS n_ok_event_bps, countIf(ok_rule) AS n_ok_rule,
  arrayStringConcat(groupArrayIf(100000)(sig, NOT ok_rule), ',') AS failing
FROM (
 SELECT instruction, sig,
  multiIf(quote_mint='$W','wsol', mint='$W','base-wsol','other-quote') AS cat,
  toInt256(assumeNotNull(pool_base_reserves)) AS B,
  toInt256(assumeNotNull(pool_quote_reserves)) + toInt256(pool_virtual_quote_reserves) AS Qe,
  toInt256(token_amount) AS base, toInt256(quote_amount) AS q, toInt256(assumeNotNull(user_quote_amount)) AS uq,
  toInt256(lp_fee_bps) AS lb, toInt256(protocol_fee_bps) AS pb, toInt256(cashback_fee_bps) AS kb,
  toInt256(assumeNotNull(lp_fee)) AS e_lf, toInt256(protocol_fee) AS e_pf, toInt256(creator_fee) AS e_cf, toInt256(cashback_fee) AS e_kf,
  toInt256(creator_fee_bps) AS cb_raw,
  if(e_cf = 0, toInt256(0), cb_raw) AS cb_rule,
  -- com o bps do criador do evento
  multiIf(instruction='sell', intDiv(Qe*base, B+base), instruction='buy', intDiv(Qe*base + (B-base) - 1, B-base), intDiv(q*10000, 10000+lb+pb+cb_raw+kb)) AS amt1,
  intDiv(amt1*lb+9999,10000) + intDiv(amt1*pb+9999,10000) + intDiv(amt1*cb_raw+9999,10000) + intDiv(amt1*kb+9999,10000) AS tf1,
  least(amt1, q - tf1) AS net1,
  multiIf(instruction='sell', amt1 = q AND q - tf1 = uq, instruction='buy', amt1 = q AND q + tf1 = uq, intDiv(B*(net1-1), Qe+net1-1) = base AND net1 = uq)
    AND intDiv(amt1*lb+9999,10000) = e_lf AND intDiv(amt1*pb+9999,10000) = e_pf AND intDiv(amt1*cb_raw+9999,10000) = e_cf AND intDiv(amt1*kb+9999,10000) = e_kf AS ok_raw,
  -- com a regra de pool sem criador
  multiIf(instruction='sell', intDiv(Qe*base, B+base), instruction='buy', intDiv(Qe*base + (B-base) - 1, B-base), intDiv(q*10000, 10000+lb+pb+cb_rule+kb)) AS amt2,
  intDiv(amt2*lb+9999,10000) + intDiv(amt2*pb+9999,10000) + intDiv(amt2*cb_rule+9999,10000) + intDiv(amt2*kb+9999,10000) AS tf2,
  least(amt2, q - tf2) AS net2,
  multiIf(instruction='sell', amt2 = q AND q - tf2 = uq, instruction='buy', amt2 = q AND q + tf2 = uq, intDiv(B*(net2-1), Qe+net2-1) = base AND net2 = uq)
    AND intDiv(amt2*lb+9999,10000) = e_lf AND intDiv(amt2*pb+9999,10000) = e_pf AND intDiv(amt2*cb_rule+9999,10000) = e_cf AND intDiv(amt2*kb+9999,10000) = e_kf AS ok_rule
 FROM v_pumpswap_trades(from_slot=$a, to_slot=$b) WHERE has_extra AND pool_base_reserves IS NOT NULL AND lp_fee IS NOT NULL
) GROUP BY instruction, cat FORMAT TSV
SQL
done
