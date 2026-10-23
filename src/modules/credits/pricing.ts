import { z } from "zod";
import type { Rates } from "../policy";
export const usageSchema = z
  .object({
    input: z.number().int().min(0).max(1000000000),
    cachedInput: z.number().int().min(0).max(1000000000),
    cacheWrite5m: z.number().int().min(0).max(1000000000),
    cacheWrite1h: z.number().int().min(0).max(1000000000),
    output: z.number().int().min(0).max(1000000000),
    reasoning: z.number().int().min(0).max(1000000000),
    searchCalls: z.number().int().min(0).max(10000),
    audioInput: z.number().int().min(0).max(1000000000).optional(),
    audioMilliseconds: z.number().int().min(1).max(240000).optional(),
  })
  .strict()
  .superRefine((u, c) => {
    if (
      u.audioMilliseconds !== undefined &&
      [
        u.input,
        u.cachedInput,
        u.cacheWrite5m,
        u.cacheWrite1h,
        u.output,
        u.reasoning,
        u.searchCalls,
        u.audioInput ?? 0,
      ].some((n) => n !== 0)
    )
      c.addIssue({ code: "custom", message: "Duration fallback cannot include token usage" });
  });
/** Categories are disjoint; reasoning is included in output and is informational only. */
export type Usage = z.infer<typeof usageSchema>;
export const emptyUsage = (): Usage => ({
  input: 0,
  cachedInput: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  output: 0,
  reasoning: 0,
  searchCalls: 0,
});
function contextRates(inputTokens: number, rates: Rates): Rates {
  return rates.longContext && inputTokens > rates.longContext.inputTokensAbove
    ? rates.longContext.rates
    : rates;
}
export function charge(usage: Usage, rates: Rates): bigint {
  usageSchema.parse(usage);
  rates = contextRates(
    usage.input + usage.cachedInput + usage.cacheWrite5m + usage.cacheWrite1h,
    rates,
  );
  if (usage.audioMilliseconds !== undefined) {
    if (rates.audioMinute === undefined) throw new Error("Audio duration tariff is missing");
    return (BigInt(usage.audioMilliseconds) * BigInt(rates.audioMinute) + 59999n) / 60000n;
  }
  let millionths = 0n;
  if (usage.audioInput !== undefined) {
    if (rates.audioInput === undefined) throw new Error("Audio token tariff is missing");
    millionths += BigInt(usage.audioInput) * BigInt(rates.audioInput);
  }
  for (const key of ["input", "cachedInput", "cacheWrite5m", "cacheWrite1h", "output"] as const)
    millionths += BigInt(usage[key]) * BigInt(rates[key]);
  return (millionths + 999999n) / 1000000n + BigInt(usage.searchCalls) * BigInt(rates.searchCall);
}
export function holdCost(input: number, output: number, searchCalls: number, rates: Rates): bigint {
  rates = contextRates(input, rates);
  const maxInput = [rates.input, rates.cachedInput, rates.cacheWrite5m, rates.cacheWrite1h]
    .map(BigInt)
    .reduce((a, b) => (a > b ? a : b));
  return (
    (BigInt(input) * maxInput + BigInt(output) * BigInt(rates.output) + 999999n) / 1000000n +
    BigInt(searchCalls) * BigInt(rates.searchCall)
  );
}

/** Reserve the reviewed native token ceilings or duration tariff, whichever is higher.
 * Transcriptions have no output-limit parameter; model caps must be native model limits.
 */
export function audioHoldCost(
  input: number,
  output: number,
  milliseconds: number,
  rates: Rates,
): bigint {
  if (rates.audioInput === undefined) throw new Error("Audio token tariff is missing");
  const maxInput =
    BigInt(rates.audioInput) > BigInt(rates.input) ? BigInt(rates.audioInput) : BigInt(rates.input);
  const tokens =
    (BigInt(input) * maxInput + BigInt(output) * BigInt(rates.output) + 999999n) / 1000000n;
  const duration =
    rates.audioMinute === undefined
      ? 0n
      : (BigInt(milliseconds) * BigInt(rates.audioMinute) + 59999n) / 60000n;
  return tokens > duration ? tokens : duration;
}
