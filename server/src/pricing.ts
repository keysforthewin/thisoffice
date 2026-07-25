import type { ModelTokens } from '../../shared/types.ts';

/**
 * Static USD-per-million-token price table, as of July 2026. Prices drift —
 * everything downstream of this file must render its output as "est.".
 * Matched by substring on the model id; first match wins.
 */
interface FamilyRate {
  match: string;
  input: number;
  output: number;
}

const FAMILY_RATES: FamilyRate[] = [
  { match: 'opus', input: 15, output: 75 },
  { match: 'sonnet', input: 3, output: 15 },
  { match: 'haiku', input: 1, output: 5 },
  // assume Opus-tier pricing for these
  { match: 'fable', input: 15, output: 75 },
  { match: 'mythos', input: 15, output: 75 },
];

function rateFor(model: string): FamilyRate | undefined {
  const lower = model.toLowerCase();
  return FAMILY_RATES.find((r) => lower.includes(r.match));
}

/**
 * Sums estimated cost across models whose family matched a known price tier;
 * models with no family match are skipped. Returns null only if NO model
 * matched, so the UI can hide the cost page instead of showing $0.00.
 */
export function estCostUSD(tokensByModel: Record<string, ModelTokens>): number | null {
  let total = 0;
  let matched = false;
  for (const [model, tokens] of Object.entries(tokensByModel)) {
    const rate = rateFor(model);
    if (!rate) continue;
    matched = true;
    const cacheReadRate = rate.input * 0.1;
    const cacheWriteRate = rate.input * 1.25;
    total +=
      (tokens.input * rate.input +
        tokens.output * rate.output +
        tokens.cacheRead * cacheReadRate +
        tokens.cacheCreation * cacheWriteRate) /
      1_000_000;
  }
  return matched ? total : null;
}
