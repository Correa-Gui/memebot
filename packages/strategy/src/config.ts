import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Schema zod de `config/strategy.v0.yaml` (CLAUDE.md §6: config lida do disco é fronteira
 * externa, sempre validada). Espelha o arquivo inteiro, mesmo as seções que esta tarefa
 * (Fase 3/parte A do `docs/ROADMAP.md`: só `packages/features` e `packages/strategy` v0, filtros
 * duros + gatilho) ainda não usa (`exits`, `risk`, `signals`, que são "parte B") — não dá para
 * carregar o arquivo validando só um pedaço dele.
 */
const TakeProfitStepSchema = z.object({
  gainPct: z.number().positive(),
  sellFraction: z.number().positive().max(1),
});

/**
 * Hipótese (a) "confirmação" (experimento de 2026-10-02, docs/STRATEGY.md §8): depois do gatilho, o sinal
 * fica pendente `windowSec` s e só vira entrada se o preço marginal se SUSTENTAR — nunca abaixo de
 * `preçoDoSinal × (1 − maxDipPct)` durante a janela (cancela na hora) e, no fim da janela, ≥ preço do
 * sinal. No disparo os filtros duros (§3) são reavaliados. Ausente = desligado (v0.1).
 */
const ConfirmationSchema = z.object({
  windowSec: z.number().positive(),
  maxDipPct: z.number().positive().max(1),
});

/**
 * Hipótese (c) "recuo" (experimento de 2026-10-02): o gatilho de momentum só ARMA o token; a entrada
 * acontece quando o preço marginal recuar `retracePct` do máximo observado desde o sinal (o "pico"), em
 * até `windowSec` s, com compradores únicos ainda ativos (`uniqueBuyers60s ≥ minUniqueBuyers60s`), sem
 * venda individual > `entry.maxSingleSellPctSupply60s` nos últimos 60 s e com os filtros duros (§3)
 * reavaliados. Ausente = desligado (v0.1).
 */
const PullbackSchema = z.object({
  retracePct: z.number().positive().max(1),
  windowSec: z.number().positive(),
  minUniqueBuyers60s: z.number().int().nonnegative(),
});

const EntrySchema = z.object({
  minAgeSec: z.number().nonnegative(),
  maxAgeSec: z.number().positive(),
  minBuySellVolumeRatio60s: z.number().positive(),
  minUniqueBuyers60s: z.number().int().nonnegative(),
  requirePriceAboveMean120s: z.boolean(),
  maxSingleSellPctSupply60s: z.number().positive().max(1),
  /**
   * Hipótese (b) "não perseguir" (experimento de 2026-10-02): rejeita (`maxPriceAboveMean120sPct`) se o
   * preço atual estiver mais que esta fração acima da média de 120 s (`priceVsMean120s`). Ausente = desligado.
   */
  maxPriceAboveMean120sPct: z.number().positive().optional(),
  confirmation: ConfirmationSchema.optional(),
  pullback: PullbackSchema.optional(),
}).refine((e) => !(e.confirmation && e.pullback), { message: 'entry.confirmation e entry.pullback são exclusivos (escolha um modo de entrada)' });

const FiltersSchema = z.object({
  allowedVenues: z.array(z.enum(['curve', 'pumpswap'])).min(1),
  allowedQuoteMints: z.array(z.string().min(1)).min(1),
  maxTop10PctSupply: z.number().positive().max(1),
  maxSameSlotAsCreatePct: z.number().positive().max(1),
  maxCreatorHoldingPct: z.number().positive().max(1),
  maxCreatorTokens24h: z.number().int().nonnegative(),
  minUniqueHolders: z.number().int().nonnegative(),
  minVolume60sSol: z.number().nonnegative(),
  maxRiskScore: z.number().min(0).max(1),
});

/**
 * Universo de tokens GRADUADOS (experimento de 2026-10-03, só replay): com `pumpswap` em
 * `filters.allowedVenues`, um token no PumpSwap é avaliado pela janela de tempo DESDE A GRADUAÇÃO
 * (`curve_completed` visto no run) em vez da idade desde a criação (`entry.min/maxAgeSec` valem só para a
 * curva), e opcionalmente pelo market cap em US$ (quote efetivo × supply / base, com o preço SOL/US$
 * injetado por quem chama). Obrigatório quando `pumpswap` está em `allowedVenues`.
 */
const GraduatedSchema = z.object({
  minSinceGraduationSec: z.number().nonnegative(),
  maxSinceGraduationSec: z.number().positive(),
  minMarketCapUsd: z.number().positive().optional(),
  maxMarketCapUsd: z.number().positive().optional(),
});

const SizingSchema = z.object({
  sizeSol: z.number().positive(),
  maxOwnPriceImpactPct: z.number().positive().max(1),
});

const ExitsSchema = z.object({
  takeProfit: z.array(TakeProfitStepSchema).min(1),
  trailingStopPct: z.number().positive().max(1),
  stopLossPct: z.number().positive().max(1),
  timeStopSec: z.number().int().positive(),
  emergency: z.object({
    singleSellPctSupply: z.number().positive().max(1),
    exitOnCreatorSell: z.boolean(),
  }),
});

const SignalsSchema = z.object({
  riskModel: z.object({ enabled: z.boolean(), path: z.string() }),
  narrative: z.object({ enabled: z.boolean(), minMatch: z.number().min(0).max(1) }),
  smartMoney: z.object({ enabled: z.boolean(), minWallets: z.number().int().nonnegative() }),
});

const RiskSchema = z.object({
  maxOpenPositions: z.number().int().positive(),
  maxDailyLossSol: z.number().positive(),
});

export const StrategyConfigSchema = z.object({
  version: z.string(),
  entry: EntrySchema,
  filters: FiltersSchema,
  sizing: SizingSchema,
  exits: ExitsSchema,
  signals: SignalsSchema,
  risk: RiskSchema,
  graduated: GraduatedSchema.optional(),
}).refine((c) => !c.filters.allowedVenues.includes('pumpswap') || c.graduated !== undefined, {
  message: 'filters.allowedVenues com pumpswap exige o bloco graduated (janela desde a graduação)',
});

export type StrategyV0Config = z.infer<typeof StrategyConfigSchema>;

/** Modo de entrada derivado da config: `immediate` (v0.1), `confirmation` (hipótese a) ou `pullback` (hipótese c). */
export type EntryMode = 'immediate' | 'confirmation' | 'pullback';

export function entryMode(config: StrategyV0Config): EntryMode {
  if (config.entry.confirmation) return 'confirmation';
  if (config.entry.pullback) return 'pullback';
  return 'immediate';
}

/**
 * Carrega e valida `config/strategy.v0.yaml` (ou outro caminho equivalente).
 *
 * Parser YAML: o monorepo ainda não tinha dependência direta de YAML (`js-yaml` só aparecia
 * transitivamente via outra lib). Adicionamos `yaml` (pacote `yaml` no npm, ~40M downloads/semana,
 * mantido ativamente, API simples `parse`/`stringify`, zero dependências nativas) em vez de
 * `js-yaml` (também popular, mas API baseada em callbacks/tags mais antiga) — justificativa
 * pedida por CLAUDE.md §5 para toda dependência nova.
 *
 * Não é uma função pura (lê o disco) — por isso fica fora de `evaluate.ts`; quem monta o app
 * chama isto uma vez e passa o `StrategyV0Config` resultante para a função pura `evaluate`.
 */
export function loadStrategyConfig(filePath: string): StrategyV0Config {
  const raw = readFileSync(filePath, 'utf8');
  const parsed: unknown = parseYaml(raw);
  const result = StrategyConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Config de estratégia inválida em ${filePath}: ${result.error.message}`);
  }
  return result.data;
}
