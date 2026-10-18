import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "../../platform/db";
import { AppError } from "../../platform/errors";

// Integer millionths of a display credit. No floating-point balance arithmetic.
export const units = z.string().regex(/^(0|[1-9][0-9]{0,14})$/);
export const providerNames = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "deepseek",
  "typesafe",
] as const;
export type ProviderName = (typeof providerNames)[number];
export const ratesSchema = z
  .object({
    input: units,
    cachedInput: units,
    cacheWrite5m: units,
    cacheWrite1h: units,
    output: units,
    searchCall: units,
    audioInput: units.optional(),
    audioMinute: units.optional(),
  })
  .strict();
const cycle = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once") }).strict(),
  z.object({ kind: z.literal("fixed_days"), days: z.number().int().min(1).max(366) }).strict(),
  z.object({ kind: z.literal("calendar_month") }).strict(),
]);
type Cycle = z.infer<typeof cycle>;
const plan = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    rank: z.number().int().min(0).max(100),
    allowanceUnits: units,
    cycle,
    maxConcurrent: z.number().int().min(1).max(32),
    requestsPerMinute: z.number().int().min(1).max(1000),
    dailyLimitUnits: units.nullable(),
  })
  .strict();
export const modelSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9._:/-]{1,100}$/),
    provider: z.enum(providerNames),
    upstreamModel: z.string().regex(/^[a-zA-Z0-9._:/-]{1,100}$/),
    displayName: z.string().min(1).max(100),
    description: z.string().max(300).default(""),
    tier: z.enum(["fast", "balanced", "frontier"]).default("balanced"),
    maxDurationMs: z.number().int().min(100).max(600000).default(600000),
    idleTimeoutMs: z.number().int().min(100).max(300000).default(90000),
    enabled: z.boolean(),
    pricingReviewed: z.boolean(),
    roles: z.array(z.enum(["lead", "page", "light", "decision", "transcribe"])).min(1),
    recommendedRoles: z.array(z.enum(["lead", "page", "light", "decision", "transcribe"])),
    plans: z.array(z.string()).min(1),
    contextWindow: z.number().int().min(1).max(2_000_000),
    maxOutput: z.number().int().min(1).max(128000),
    maxRequestBytes: z
      .number()
      .int()
      .min(1024)
      .max(8 * 1024 * 1024),
    maxSearchCalls: z.number().int().min(0).max(10),
    supports: z
      .object({
        tools: z.boolean(),
        vision: z.boolean(),
        promptCache: z.boolean(),
        reasoning: z.boolean(),
        nativeSearch: z.boolean(),
      })
      .strict(),
    rates: ratesSchema,
    costRates: ratesSchema.optional(),
    pricingSource: z.string().max(300),
  })
  .strict();
export const policySchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive().max(2_000_000_000),
    enabled: z.boolean(),
    freePlan: z.string(),
    selfHostedPlan: z.string().nullable().default(null),
    defaults: z
      .record(
        z.string(),
        z
          .object({
            lead: z.string().nullable(),
            page: z.string().nullable(),
            light: z.string().nullable(),
            decision: z.string().nullable().optional(),
            transcribe: z.string().nullable().optional(),
          })
          .strict(),
      )
      .default({}),
    welcomeUnits: units,
    welcomeExpiresDays: z.number().int().min(1).max(365).nullable(),
    plans: z.array(plan).min(1).max(10),
    models: z.array(modelSchema).max(100),
    subscriptions: z
      .array(
        z
          .object({
            productId: z.uuid(),
            plan: z.string(),
            interval: z.enum(["monthly", "yearly"]),
            checkoutEnabled: z.boolean().optional(),
          })
          .strict(),
      )
      .max(20),
    topups: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
            productId: z.uuid(),
            units,
            expiresDays: z.number().int().min(1).max(3650).nullable(),
          })
          .strict(),
      )
      .max(20),
    limits: z
      .object({
        requestTimeoutMs: z.number().int().min(100).max(600000),
        unknownHoldSeconds: z.number().int().min(0).max(86400),
        globalConcurrent: z.number().int().min(1).max(256),
        maxFreeConcurrent: z.number().int().min(1).max(256).optional(),
        unconfirmedRequestsPerUserDay: z.number().int().min(1).max(100).default(3),
        budgets: z
          .object({
            scope: z.string().regex(/^[a-z0-9_-]{1,40}$/),
            dailyUsdMicros: units.nullable(),
            totalUsdMicros: units.nullable(),
            freeDailyUsdMicros: units.nullable(),
          })
          .strict()
          .optional(),
        providers: z.record(
          z.enum(providerNames),
          z
            .object({
              requestsPerMinute: z.number().int().positive().max(100000),
              tokensPerSecond: z.number().int().positive().max(10000000),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict()
  .superRefine((p, c) => {
    const ids = new Set(p.plans.map((x) => x.id));
    if (ids.size !== p.plans.length || !ids.has(p.freePlan))
      c.addIssue({ code: "custom", message: "Plans must be unique and contain freePlan" });
    if (
      new Set(p.models.map((m) => m.id)).size !== p.models.length ||
      new Set(p.models.map((m) => `${m.provider}:${m.upstreamModel}`)).size !== p.models.length
    )
      c.addIssue({ code: "custom", message: "Models must be unique" });
    const offers = p.subscriptions
      .filter((s) => s.checkoutEnabled !== false)
      .map((s) => `${s.plan}:${s.interval}`);
    if (new Set(offers).size !== offers.length)
      c.addIssue({
        code: "custom",
        message: "Only one checkout offer per plan and interval is allowed",
      });
    const productIds = [...p.subscriptions, ...p.topups].map((x) => x.productId);
    if (new Set(productIds).size !== productIds.length)
      c.addIssue({ code: "custom", message: "Product IDs must be unique" });
    if (new Set(p.topups.map((x) => x.id)).size !== p.topups.length)
      c.addIssue({ code: "custom", message: "Top-up IDs must be unique" });
    if (
      p.plans.find((plan) => plan.id === p.freePlan)?.cycle.kind === "once" &&
      BigInt(p.welcomeUnits) !== 0n
    )
      c.addIssue({ code: "custom", message: "One-time free allowance replaces the welcome grant" });
    if (
      p.limits.maxFreeConcurrent !== undefined &&
      p.limits.maxFreeConcurrent > p.limits.globalConcurrent
    )
      c.addIssue({ code: "custom", message: "Free concurrency cannot exceed global concurrency" });
    for (const m of p.models) {
      if (
        m.enabled &&
        m.costRates &&
        (BigInt(m.costRates.input) <= 0n ||
          (BigInt(m.costRates.output) === 0n && m.provider !== "typesafe") ||
          (m.supports.nativeSearch && BigInt(m.costRates.searchCall) === 0n))
      )
        c.addIssue({
          code: "custom",
          message: "Enabled model cost rates must cover input, output and enabled tools",
        });
      if (
        m.roles.includes("transcribe") &&
        (BigInt(m.rates.audioInput ?? "0") <= 0n ||
          BigInt(m.rates.audioMinute ?? "0") <= 0n ||
          (m.costRates &&
            (BigInt(m.costRates.audioInput ?? "0") <= 0n ||
              BigInt(m.costRates.audioMinute ?? "0") <= 0n)))
      )
        c.addIssue({
          code: "custom",
          message: "Transcription needs positive audio token and duration tariffs",
        });
      if (m.enabled && p.limits.budgets && !m.costRates)
        c.addIssue({
          code: "custom",
          message: "Budgeted models require independent USD cost rates",
        });
      if (
        m.roles.includes("transcribe") &&
        (m.provider !== "openai" ||
          m.roles.length !== 1 ||
          !m.rates.audioInput ||
          !m.rates.audioMinute ||
          m.supports.nativeSearch ||
          m.supports.tools ||
          m.supports.vision)
      )
        c.addIssue({
          code: "custom",
          message: "Transcription requires an exclusive OpenAI role and explicit audio tariffs",
        });
      if (m.plans.some((x) => !ids.has(x)) || m.recommendedRoles.some((x) => !m.roles.includes(x)))
        c.addIssue({ code: "custom", message: "Invalid model plan/role" });
      if (
        m.enabled &&
        (!m.pricingReviewed ||
          !m.pricingSource ||
          BigInt(m.rates.input) + BigInt(m.rates.output) === 0n)
      )
        c.addIssue({ code: "custom", message: "Enabled models need reviewed nonzero pricing" });
      if (m.maxOutput > m.contextWindow || m.supports.nativeSearch !== m.maxSearchCalls > 0)
        c.addIssue({ code: "custom", message: "Invalid model limits" });
      if (
        m.provider === "typesafe" &&
        (m.upstreamModel !== "jev-1.13.0" ||
          m.maxRequestBytes > 81920 ||
          m.contextWindow !== 64000 ||
          BigInt(m.rates.output) !== 0n)
      )
        c.addIssue({ code: "custom", message: "Jev contract mismatch" });
    }
    if (p.selfHostedPlan !== null && !ids.has(p.selfHostedPlan))
      c.addIssue({ code: "custom", message: "Invalid self-hosted plan" });
    for (const [planId, defaults] of Object.entries(p.defaults)) {
      if (!ids.has(planId)) c.addIssue({ code: "custom", message: "Invalid default plan" });
      for (const [role, id] of Object.entries(defaults)) {
        if (id === null || id === undefined) continue;
        const model = p.models.find((m) => m.id === id);
        if (
          !model?.plans.includes(planId) ||
          !model.roles.includes(role as "lead") ||
          (p.enabled && !model.enabled)
        )
          c.addIssue({
            code: "custom",
            message: "Default must be an available model with the correct role",
          });
      }
    }
    for (const sub of p.subscriptions)
      if (!ids.has(sub.plan) || sub.plan === p.freePlan)
        c.addIssue({ code: "custom", message: "Invalid subscription plan" });
  });
export type CloudPolicy = z.infer<typeof policySchema>;
export type Model = z.infer<typeof modelSchema>;
export type Rates = z.infer<typeof ratesSchema>;
export async function loadPolicy(path: string): Promise<CloudPolicy> {
  const file = Bun.file(path);
  if (file.size > 256 * 1024) throw new Error("Cloud policy exceeds limit");
  return policySchema.parse(await file.json());
}
/** Commercial identities remain stable; retire an offer without erasing existing entitlements. */
export function assertPolicyEvolution(previous: CloudPolicy, next: CloudPolicy) {
  if (
    previous.freePlan !== next.freePlan ||
    previous.plans.some((p) => !next.plans.some((n) => n.id === p.id))
  )
    throw new Error(
      "Keep existing plan identifiers and freePlan; change future allowances in place",
    );
  if (previous.limits.budgets && previous.limits.budgets.scope !== next.limits.budgets?.scope)
    throw new Error("Keep the deployment budget scope; changing policy cannot reset spend history");
  for (const old of previous.subscriptions) {
    const current = next.subscriptions.find((s) => s.productId === old.productId);
    if (!current || current.plan !== old.plan || current.interval !== old.interval)
      throw new Error(
        "Keep subscription product mappings; retire offers with checkoutEnabled=false",
      );
  }
}
export async function registerPolicy(db: Database, p: CloudPolicy) {
  const body = JSON.stringify(p);
  const digest = createHash("sha256").update(body).digest("hex");
  await db.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(91843722)`;
    const [prior] =
      await tx`SELECT configuration FROM cloud_policy p JOIN cloud_active_policy a ON a.revision=p.revision WHERE a.singleton=true`;
    if (prior) assertPolicyEvolution(prior.configuration as CloudPolicy, p);
    const [existing] = await tx`SELECT digest FROM cloud_policy WHERE revision=${p.revision}`;
    if (existing && existing.digest !== digest)
      throw new Error("Cloud policy revision reused with different content");
    await tx`INSERT INTO cloud_policy(revision,digest,configuration) VALUES (${p.revision},${digest},${JSON.stringify(p)}::jsonb) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO cloud_active_policy(singleton,revision) VALUES (true,${p.revision}) ON CONFLICT(singleton) DO UPDATE SET revision=greatest(cloud_active_policy.revision,excluded.revision)`;
    const [active] = await tx`SELECT revision FROM cloud_active_policy WHERE singleton=true`;
    if (active?.revision !== p.revision)
      throw new Error("A newer cloud policy is already active; use a new revision for rollback");
  });
}
export function findModel(p: CloudPolicy, provider: ProviderName, id: string) {
  const model = p.models.find(
    (m) => m.enabled && m.provider === provider && (m.id === id || m.upstreamModel === id),
  );
  if (!p.enabled || !model) throw new AppError("model_not_allowed", 403);
  return model;
}
export function cycleAt(
  anchor: Date,
  now: Date,
  cycle: Exclude<Cycle, { kind: "once" }>,
): { start: Date; end: Date } {
  if (now < anchor) throw new AppError("invalid_cycle", 503);
  if (cycle.kind === "fixed_days") {
    const ms = cycle.days * 86400000;
    const start = new Date(
      anchor.getTime() + Math.floor((now.getTime() - anchor.getTime()) / ms) * ms,
    );
    return { start, end: new Date(start.getTime() + ms) };
  }
  const at = (offset: number) => {
    const d = new Date(anchor);
    d.setUTCDate(1);
    d.setUTCMonth(anchor.getUTCMonth() + offset);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(anchor.getUTCDate(), last));
    return d;
  };
  let offset =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    now.getUTCMonth() -
    anchor.getUTCMonth();
  if (at(offset) > now) offset--;
  return { start: at(offset), end: at(offset + 1) };
}

export function requestDuration(policy: CloudPolicy, model: Model): number {
  return model.provider === "typesafe"
    ? Math.min(14000, model.maxDurationMs, policy.limits.requestTimeoutMs)
    : Math.min(model.maxDurationMs, policy.limits.requestTimeoutMs);
}

/** Startup is read-only: failed candidates cannot activate a policy for serving peers. */
export async function assertActivePolicy(db: Database, policy: CloudPolicy) {
  const digest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  const [row] =
    await db.sql`SELECT p.digest FROM cloud_policy p JOIN cloud_active_policy a ON a.revision=p.revision WHERE a.singleton=true AND p.revision=${policy.revision}`;
  if (row?.digest !== digest)
    throw new Error(
      "Policy is not active; validate and explicitly register it before starting services",
    );
}
