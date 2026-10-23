import { expect, test } from "bun:test";
import { ratesSchema } from "../../policy/policy";
import { charge, emptyUsage, holdCost } from "../pricing";

const base = {
  input: "1000000",
  cachedInput: "100000",
  cacheWrite5m: "1250000",
  cacheWrite1h: "2000000",
  output: "5000000",
  searchCall: "10000",
};
const long = {
  input: "2000000",
  cachedInput: "200000",
  cacheWrite5m: "2500000",
  cacheWrite1h: "4000000",
  output: "7500000",
  searchCall: "10000",
};
const rates = { ...base, longContext: { inputTokensAbove: 100, rates: long } };

test("the context threshold is exclusive and reprices the full request", () => {
  expect(charge({ ...emptyUsage(), input: 100, output: 2, reasoning: 1 }, rates)).toBe(110n);
  expect(charge({ ...emptyUsage(), input: 101, output: 2, reasoning: 1 }, rates)).toBe(217n);
});
test("all disjoint input categories count toward the threshold; output does not", () => {
  expect(charge({ ...emptyUsage(), input: 100, output: 500 }, rates)).toBe(2600n);
  for (const key of ["cachedInput", "cacheWrite5m", "cacheWrite1h"] as const) {
    const usage = { ...emptyUsage(), input: 100, [key]: 1, output: 2 };
    expect(charge(usage, rates)).toBe(charge(usage, long));
  }
});
test("an estimate may reserve the long tier while actual usage settles at the base tier", () => {
  expect(holdCost(101, 2, 0, rates)).toBe(419n);
  expect(charge({ ...emptyUsage(), input: 2, output: 1 }, rates)).toBe(7n);
});
test("holds cover every input category through the threshold and search fees stay per-call", () => {
  for (const input of [0, 99, 100, 101, 1000]) {
    for (const key of ["input", "cachedInput", "cacheWrite5m", "cacheWrite1h"] as const) {
      expect(holdCost(input, 5, 2, rates)).toBeGreaterThanOrEqual(
        charge({ ...emptyUsage(), [key]: input, output: 5, reasoning: 3, searchCalls: 2 }, rates),
      );
    }
  }
});
test("historical flat tariffs remain unchanged and tier policy cannot reduce reservation safety", () => {
  expect(ratesSchema.parse(base)).toEqual(base);
  expect(charge({ ...emptyUsage(), input: 101, output: 2 }, base)).toBe(111n);
  expect(
    ratesSchema.safeParse({
      ...rates,
      longContext: { inputTokensAbove: 100, rates: { ...long, output: "1" } },
    }).success,
  ).toBe(false);
  expect(ratesSchema.safeParse({ ...rates, audioInput: "1" }).success).toBe(false);
});
