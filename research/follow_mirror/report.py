"""Format the frozen exploratory follow run; no database or network writes."""
import csv
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path('data/reports/follow-mirror-2026-10-06')


def main():
    summary = json.loads((ROOT / 'summary.json').read_text(encoding='utf8'))
    outcomes = []
    manifest = []
    for path in sorted((ROOT / 'parts').glob('outcomes-k*.json')):
        raw = path.read_bytes()
        rows = json.loads(raw)['outcomes']
        outcomes.extend(rows)
        manifest.append({'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'rows': len(rows)})
    assert len(outcomes) == summary['eligibleSignals'] * 6, 'Incomplete outcome ledger'
    assert len({(r['trader'], r['mint'], r['delay'], r['policy']) for r in outcomes}) == len(outcomes), 'Duplicate outcomes'
    for r in outcomes:
        bought = sum(int(f['tokens']) for f in r['fills'] if f['side'] == 'buy')
        sold = sum(int(f['tokens']) for f in r['fills'] if f['side'] == 'sell')
        cash = sum(int(f['quote']) * (1 if f['side'] == 'sell' else -1) - int(f['networkFee']) for f in r['fills'])
        assert bought - sold == int(r['remaining']) >= 0, 'Token conservation failed'
        assert cash == int(r['pnl']), 'Cash accounting failed'
        assert all(f['ms'] >= f['dueMs'] for f in r['fills']), 'Fill before its scheduled time'
        assert r['status'] != 'closed' or int(r['remaining']) == 0, 'Closed position with residual'
    for s in summary['summary']:
        for policy in ('mirror', 'fixed'):
            rs = [r for r in outcomes if r['delay'] == s['delay'] and r['policy'] == policy
                  and (s['kind'] == 'total' or r['type'] == s['kind']) and r['entryMs'] is not None]
            assert len(rs) == s[policy]['entries'], 'Entry count does not match summary'
            assert abs(sum(int(r['pnl']) for r in rs) / 1e9 - s[policy]['pnlSol']) < 1e-8, 'PnL does not match summary'
    ledger = ROOT / 'trades.csv'
    fields = ['trader', 'mint', 'type', 'delay', 'policy', 'signalMs', 'entryMs', 'exitMs', 'status', 'reason',
              'pnl_lamports', 'dex_fees_lamports', 'network_fees_lamports', 'remaining_tokens', 'fills', 'unknownInventory']
    with ledger.open('w', encoding='utf8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for r in outcomes:
            writer.writerow({**{k: r[k] for k in fields if k in r and k != 'fills'}, 'pnl_lamports': r['pnl'],
                             'dex_fees_lamports': r['dexFees'], 'network_fees_lamports': r['networkFees'],
                             'remaining_tokens': r['remaining'], 'fills': len(r['fills'])})
    (ROOT / 'trades.csv.gz').write_bytes(gzip.compress(ledger.read_bytes(), mtime=0))
    stats = []
    for delay in (1, 5, 30):
        for policy in ('mirror', 'fixed'):
            rs = [r for r in outcomes if r['delay'] == delay and r['policy'] == policy and r['entryMs'] is not None]
            lags = sorted((f['ms'] - f['dueMs']) / 1000 for r in rs for f in r['fills'])
            entry_lags = sorted((r['entryMs'] - r['signalMs']) / 1000 for r in rs)
            holds = sorted((r['exitMs'] - r['entryMs']) / 60000 for r in rs if r['exitMs'] is not None)
            percentile = lambda xs, p: xs[min(int(len(xs) * p), len(xs)-1)] if xs else None
            pnl = sum(int(r['pnl']) for r in rs)
            net = sum(int(r['networkFees']) for r in rs)
            fills = sum(len(r['fills']) for r in rs)
            stats.append({'delay': delay, 'policy': policy, 'fills': fills, 'positive': sum(int(r['pnl']) > 0 for r in rs),
                          'pnl_sol': pnl / 1e9, 'pnl_with_old_network_37275_sol': (pnl + net - fills * 37275) / 1e9,
                          'extra_wait_seconds_p50_p95_max': [percentile(lags, .5), percentile(lags, .95), percentile(lags, 1)],
                          'entry_after_signal_seconds_p50_p95_max': [percentile(entry_lags, .5), percentile(entry_lags, .95), percentile(entry_lags, 1)],
                          'hold_minutes_p50_p95_max': [percentile(holds, .5), percentile(holds, .95), percentile(holds, 1)]})
    (ROOT / 'execution-diagnostics.json').write_text(json.dumps(stats, indent=2), encoding='utf8')
    (ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf8')
    with (ROOT / 'comparison.csv').open('w', encoding='utf8', newline='') as f:
        fields = ['type', 'delay_seconds', 'wallets', 'signals', 'entries', 'closed', 'unfilled', 'unknown_inventory',
                  'mirror_pnl_sol', 'mirror_ci95_low', 'mirror_ci95_high', 'fixed_pnl_sol', 'fixed_ci95_low', 'fixed_ci95_high',
                  'paired_delta_sol', 'delta_ci95_low', 'delta_ci95_high', 'historical_matched_pnl_sol', 'historical_matched_entries']
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for s in summary['summary']:
            a, b, d = s['mirror'], s['fixed'], s['pairedDelta']
            writer.writerow(dict(zip(fields, [s['kind'], s['delay'], s['wallets'], s['signals'], a['entries'], a['closed'], a['unfilled'], a['unknownInventory'],
                a['pnlSol'], *(a['ci95Sol'] or [None, None]), b['pnlSol'], *(b['ci95Sol'] or [None, None]),
                d['pnlSol'], *(d['ci95Sol'] or [None, None]), s['historicMatched']['pnlSol'], s['historicMatched']['entries']])))
    def fmt(x):
        ci = x['ci95Sol']
        return f"{x['pnlSol']:+.4f} [{ci[0]:+.4f}; {ci[1]:+.4f}]" if ci else 'sem amostra'
    labels = {'human probable': 'Humano provável', 'bot probable': 'Bot provável', 'sniper': 'Sniper', 'creator': 'Criador', 'total': '**Total**'}
    table = '\n'.join(f"| {labels[s['kind']]} | {s['delay']} | {s['mirror']['entries']} / {s['mirror']['closed']} | {fmt(s['mirror'])} | {fmt(s['fixed'])} | {fmt(s['pairedDelta'])} |" for s in summary['summary'])
    closed_table = '\n'.join(f"| {labels[s['kind']]} | {s['delay']} | {s['mirror']['unfilled']} | {s['mirror']['unknownInventory']} | {fmt(s['mirror']['closedOnly'])} | {fmt(s['mirror']['knownInventoryOnly'])} |" for s in summary['summary'])
    prior = json.loads(Path('data/reports/_wallet_follow_types_2026-10-05.json').read_text(encoding='utf8'))
    old_table = []
    for s in summary['summary']:
        old = prior[s['kind']][f"delay_{s['delay']}s"]
        old_table.append(f"| {labels[s['kind']]} | {s['delay']} | {old['entries']} | {fmt(old)} | {s['historicMatched']['entries']} | {fmt(s['historicMatched'])} |")
    old_table = '\n'.join(old_table)
    costs = summary['networkCostHours']
    cost_range = [min(int(x['fee']) for x in costs), max(int(x['fee']) for x in costs)]
    exclusions = '\n'.join(f"| {s['delay']} | {s['signals']} | {s['noEntry']} | {s['censored']} | {s['mirror']['entries']} |" for s in summary['summary'] if s['kind'] == 'total')
    timing = '\n'.join(f"| {s['delay']} | {s['policy']} | {s['fills']} | {s['entry_after_signal_seconds_p50_p95_max']} | {s['hold_minutes_p50_p95_max']} | {s['pnl_with_old_network_37275_sol']:+.4f} |" for s in stats)
    total = [s for s in summary['summary'] if s['kind'] == 'total']
    headline = '\n'.join(f"- **{s['delay']} s:** espelho {fmt(s['mirror'])} SOL; fixa recalculada {s['fixed']['pnlSol']:+.4f} SOL; delta {fmt(s['pairedDelta'])} SOL." for s in total)
    report = f'''# Smart money: seguir a saída — exploratório — 06/10/2026

**B já foi usado na análise anterior. Este teste é exploratório, não validação fora da amostra.**
A confirmação exige dados novos **posteriores a 05/10/2026 18:37 UTC**, sem reutilizar B para declarar aprovação.
Nenhuma estratégia, configuração do bot ou estado do pm2 foi alterado nesta tarefa.

## Leitura dos resultados

{headline}

Nesta amostra, espelhar a saída **não produziu lucro líquido agregado**: os três ICs conservadores estão abaixo
de zero. A melhora em relação à fixa é detectável a 5 e 30 s neste bootstrap, mas não a 1 s; melhora relativa
não significa lucro. Mesmo o PnL agregado somente das posições encerradas é negativo nos três cenários.
Humanos prováveis, bots e snipers têm PnL conservador negativo e IC abaixo de zero; o criador tem IC amplo,
incluindo zero, e apenas uma carteira. Não há base neste teste para alterar estratégia ou declarar vantagem validada.

## Objetivo e desenho congelado

Mesmo bloco de 43h40m55s: A começa em `{summary['from']}`; B começa em `{summary['split']}` e termina
em `{summary['end']}`. Preservei os milissegundos do corte original, citado de forma abreviada no pedido.
Mesmas 50 tops por PnL de A; classes calculadas exclusivamente em A e prioridade exclusiva
**sniper → bot → criador → humano provável**: 20 / 21 / 1 / 8 carteiras.
Rótulos são heurísticos; “humano provável” não é identidade humana verificada.

- Uma compra hipotética por **primeira compra carteira+mint em B**, como antes; não aumentar nossa posição
  nas compras subsequentes da líder. Orçamento por entrada: **0,05 SOL incluindo taxas DEX**, mais rede.
- Três cenários: atraso de entrada/saída **1/1 s, 5/5 s e 30/30 s**. Não é um grid de nove combinações.
- Espelho: quantidade nossa vendida = saldo nosso restante × quantidade vendida pela líder / saldo observado
  da líder imediatamente antes da venda. Arredondamento para baixo; venda integral da líder zera nosso saldo.
  Compras adicionais da líder atualizam o denominador. Cada venda parcial nossa paga rede novamente.
- Saldo líder reconstruído de trades SOL/WSOL disponíveis anteriores à entrada, incluindo histórico anterior
  a A somente para inventário. Transferências, holdings anteriores ao início da gravação e outros mercados
  não são observados. Se houver venda acima do saldo observado, fração é limitada a 100% e a carteira+mint é
  marcada como inventário incerto. Essa flag também agrega inconsistências observadas mais tarde em B e é
  apenas um diagnóstico retrospectivo; não seleciona entradas ou decide os trades.
- **60 minutos desde nossa entrada** é limite total, inclusive após vendas parciais; o relógio não reinicia.
  Stop −50% usa valor líquido de liquidação do restante + caixa já realizado − rede paga e projetada.
  O stop é avaliado na observação atual, sem atraso adicional deliberado; após um salto de preço a perda pode
  ultrapassar 50%. Stop/timeout têm prioridade sobre ordens parciais ainda aguardando cotação.
- Referência fixa recalculada: +40% / −20% do valor líquido executável e horizonte de 10 minutos,
  **mesmas entradas, curve-math e custo de rede** do espelho. Também não aplica atraso adicional ao gatilho de stop/TP.

## Execução, preços e custos

Somente SELECTs no banco. Em cada mint, ordem `(ts, slot, received_at, recv_seq, sig, event_index)`;
duplicatas `(sig,event_index)` descartadas. Timestamps on-chain têm resolução limitada; dentro deles a ordem
observada pelo recorder é aproximação, não a posição exata da nossa transação em um bloco.

Usa a primeira observação executável **em ou após** o horário devido, com reservas **após** o trade observado.
Na curva, reservas pós-trade vêm do evento. No PumpSwap, reservas pré-trade + resultado de curve-math
reconstroem o estado pós-trade (incluindo reserva virtual e taxa de LP que fica na pool).
Não usa preço médio `quote/token` como fill. As compras/vendas próprias usam bigint e
`bondingCurveBuy/Sell`, `pumpSwapBuyExactQuoteIn/Sell`, respeitando reservas reais e arredondamento.

As taxas DEX vêm dos bps do evento bruto decodificado pelo IDL local; PumpSwap trata pool sem criador.
Eventos de curva com cashback não suportado são descartados e contados. Taxas já estão no desembolso/recebimento;
**não são subtraídas duas vezes**. Offset virtual e impacto do tamanho de 0,05 SOL entram no cálculo.
Ordens parciais na mesma observação atualizam as reservas entre si. Na próxima observação, volta-se à trajetória
histórica: não há simulação contrafactual da reação de terceiros nem propagação permanente do nosso impacto.
Múltiplas carteiras/mints são operações independentes, sem limite global de capital ou concorrência de carteira.
Quando há mais de uma pool/venue, utiliza-se a da observação corrente; não há roteamento ótimo.

**Rede é estimada com amostras reais, não é um custo realizado de operações hipotéticas:** mediana de
`fee + jito_tip` de transações com uma assinatura, nas 24h **anteriores ao início da hora** da execução.
Mínimo de 30 amostras; neste run houve dados suficientes em todas as horas. Tip ausente é tratado como zero.
Custo por execução variou de **{cost_range[0]:,} a {cost_range[1]:,} lamports**, cobrado na entrada e em toda saída parcial.
Não usa amostras futuras. Sem falhas simuladas de transação, custos de tentativa, rent não recuperável ou
slippage estocástico adicional. Conta de token suposta reutilizada ou com rent recuperável; saldo/rent preso e
competição por inclusão são riscos não cobertos. Portanto não é promessa de fill executável ao vivo.

## Amostra, censura e posições sem saída

Dos **{summary['inputSignals']:,}** sinais anteriores, **{summary['lateSignalsExcluded']:,}** foram excluídos pelo
critério temporal pré-fixado `sinal + 60min30s < fim de B`; restaram **{summary['eligibleSignals']:,}**.
Se a entrada efetiva atrasar tanto que entrada + 60min alcance o corte, os dois métodos a excluem igualmente.
Isso evita dar à referência de 10 minutos uma amostra final privilegiada. Não usa dados depois de B para fechar posições.

| Atraso s | Sinais após corte temporal | Sem entrada | Entrada censurada | Entradas |
|---:|---:|---:|---:|---:|
{exclusions}

Se não houver trade/cotação válida no momento previsto, a ordem espera a próxima observação até B terminar.
**O fill não é retrodatado** à última cotação anterior. Por isso a execução efetiva pode superar 60 minutos;
o vencimento é do sinal de saída, não garantia de liquidez. Se nenhuma saída executável aparecer até o fim,
a posição fica `unfilled`, sem preço de saída inventado.

O agregado principal abaixo é **PnL líquido conservador com residual dessas posições marcado a zero**:
recebimentos líquidos − desembolso − rede. É um limite inferior contábil condicionado às premissas, **não PnL
realizado de todas as posições**. Mostro também as posições efetivamente encerradas e a sensibilidade de inventário.

## Comparação pareada — SOL [IC 95%]

IC percentil com **2.000 reamostragens de clusters de mint**, seed determinístico 51934: todas as carteiras que
seguem o mesmo mint ficam juntas. Delta = espelho − fixa, calculado por carteira+mint pareados antes do bootstrap.
IC é de PnL total em uma amostra do mesmo tamanho; não é retorno previsto. Dependência entre mints, carteiras e
regimes não é totalmente capturada. Não há correção por múltiplas comparações; os quatro tipos são descritivos.

| Tipo | Atraso s | Entradas / fechadas espelho | Espelho conservador | Fixa recalculada conservadora | Delta pareado |
|---|---:|---:|---:|---:|---:|
{table}

## Sensibilidades — SOL [IC 95%]

“Só fechadas” exclui posições sem saída e tem **viés de sobrevivência**, não substitui o agregado principal.
“Inventário sem inconsistência detectada” também é seleção retrospectiva e não prova ausência de transferências.
Em especial, há apenas **uma carteira** no grupo exclusivo criador.

| Tipo | Atraso s | Sem saída | Inventário incerto | Espelho só fechadas | Espelho sem inconsistência detectada |
|---|---:|---:|---:|---:|---:|
{closed_table}

## Comparação com os números publicados em 05/10

O histórico usava preço médio de trades, custo de rede constante de 37.275 lamports por perna e saída no
último preço até 10min. Portanto comparar diretamente totais históricos com este run mistura mudança de saída,
modelo de execução e amostra. O teste pareado principal acima isola a política com o novo motor comum.
“Histórico nos sinais comuns” apenas filtra o resultado antigo pelas entradas atuais; não recalcula seus fills.

| Tipo | Atraso s | Entradas antigas | Fixa publicada: SOL [IC95%] | Entradas históricas comuns | Fixa antiga nos sinais comuns: SOL [IC95%] |
|---|---:|---:|---:|---:|---:|
{old_table}

## Latências efetivas e sensibilidade de rede

Vetores abaixo são **p50 / p95 / máximo**. O custo constante antigo é apenas uma sensibilidade; o resultado
principal usa as amostras causais por hora. Latência grande reflete ausência de observação executável, não o
atraso de configuração. Ela limita a interpretação de “saída a mercado em 60 min”.

| Atraso s | Método | Execuções | Entrada após sinal (s) | Holding fechado (min) | PnL com rede fixa antiga (SOL) |
|---:|---|---:|---|---|---:|
{timing}

Diagnóstico da leitura/decodificação: `{json.dumps(summary['stats'], ensure_ascii=False)}`.
O contador `swap_reconstruction_exact` confere baseOut nas compras e netQuoteOut nas vendas; em compra de base
exata o baseOut é o próprio input e essa checagem não valida sozinha os valores de quote. A matemática usada
tem os testes golden do repositório, mas não foi feita nova auditoria byte a byte de todos os campos de cada swap.

## Artefatos e reprodução

- `follow-mirror-2026-10-06/summary.json`: números, exclusões, custos horários e SHA-256 das entradas anteriores.
- `follow-mirror-2026-10-06/comparison.csv`: tabela principal em formato tabular.
- `follow-mirror-2026-10-06/trades.csv`: ledger compacto, com status, custo, saldo e flags por operação.
- `follow-mirror-2026-10-06/trades.csv.gz`: cópia comprimida do mesmo ledger para versionamento.
- `follow-mirror-2026-10-06/parts/outcomes-k*.json`: todas as execuções parciais; hashes em `manifest.json`.
- `follow-mirror-2026-10-06/inputs.json`: sinais e classes usados, congelados.
- `follow-mirror-2026-10-06/execution-diagnostics.json`: latência, quantidade de fills e sensibilidade de rede.

Na raiz, com os relatórios anteriores e o ClickHouse histórico disponíveis:

```powershell
node --experimental-strip-types --disable-warning=ExperimentalWarning --max-old-space-size=1536 apps/bot/src/research/follow-mirror.ts
python research/follow_mirror/report.py
```

Os scripts não alteram estratégia/pm2 nem gravam tabelas. A reprodução exige que raw_b64 ainda exista no banco;
se o TTL expirar, restaurar o snapshot em ambiente de pesquisa separado (este script não restaura automaticamente).
Não rerodar contra histórico incompleto sem conferir contadores de raw ausente. O manifesto identifica os
artefatos desta execução, não promete igualdade com um banco alterado no futuro.

## Verificação e estado do trabalho

- Typecheck passou; lint dos três arquivos TypeScript novos passou.
- `pnpm check` foi executado: typecheck passou, lint geral parou em 47 erros preexistentes (14 no exportador
  anterior e 33 em scripts de análise de `data/reports`). Nenhum erro de lint novo foi acrescentado.
- Suíte completa executada separadamente: 50 arquivos, **2.357 testes aprovados**, incluindo dez desta análise.
- `pnpm audit --prod`: nenhuma vulnerabilidade conhecida. Logs em `data/reports/follow-mirror-*-2026-10-06.log`.
- Conferência do ledger: 6 resultados por sinal elegível, sem duplicatas; contagens e PnL reproduzem o resumo
  para todos os tipos, atrasos e métodos. Uma colisão inicial A/a nos nomes de lote do Windows foi corrigida
  usando códigos ASCII e recompondo os lotes ausentes; o teste cobre os 58 prefixos base58. Os arquivos antigos
  `outcomes-X.json` diretamente na pasta raiz são intermediários incompletos e **não são a fonte final**;
  usar exclusivamente `parts/outcomes-kNNN.json` e o manifesto.
- ROADMAP: teste exploratório concluído, confirmação em dados novos permanece pendente; nenhum parâmetro da
  estratégia alterado, nenhum comando pm2 executado e nenhum dado do banco escrito por este script.

Próximo passo científico: definir o protocolo de confirmação antes de olhar os dados posteriores ao corte.
O resultado atual não autoriza otimizar saídas repetidamente em B nem promover o teste a estratégia.
'''
    Path('data/reports/follow-mirror-exploratory-2026-10-06.md').write_text(report, encoding='utf8')
    print(json.dumps({'summaries': summary['summary'], 'diagnostics': stats}, indent=2))


if __name__ == '__main__':
    main()
