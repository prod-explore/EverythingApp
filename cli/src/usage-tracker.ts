export interface PricingRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

/** Cost in USD of one call at the given per-million-token rates. Prices come from the model catalog (see providers/registry.ts). */
export function costOf(
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
  rates: PricingRates,
): number {
  return (
    (usage.input_tokens / 1_000_000) * rates.inputPerMTok +
    (usage.output_tokens / 1_000_000) * rates.outputPerMTok +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * rates.cacheWritePerMTok +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * rates.cacheReadPerMTok
  );
}
