import { type CloudPolicy, policySchema, providerNames } from "../../src/modules/policy/policy";
import type { Database } from "../../src/platform/db";

let nextRevision = 1000;

/** All prices and product IDs here are synthetic test data. */
export function testPolicy(overrides: Partial<CloudPolicy> = {}): CloudPolicy {
  const providers = Object.fromEntries(
    providerNames.map((name) => [name, { requestsPerMinute: 1000, tokensPerSecond: 100000 }]),
  );
  return policySchema.parse({
    schemaVersion: 1,
    revision: nextRevision++,
    enabled: true,
    freePlan: "free",
    welcomeUnits: "20",
    welcomeExpiresDays: 30,
    plans: [
      {
        id: "free",
        rank: 0,
        allowanceUnits: "100",
        cycle: { kind: "calendar_month" },
        maxConcurrent: 2,
        requestsPerMinute: 100,
        dailyLimitUnits: null,
      },
    ],
    models: [
      {
        id: "test-model",
        provider: "openai",
        upstreamModel: "synthetic-test-model",
        displayName: "Synthetic test model",
        enabled: true,
        pricingReviewed: true,
        roles: ["lead"],
        recommendedRoles: ["lead"],
        plans: ["free"],
        contextWindow: 100000,
        maxOutput: 1000,
        maxRequestBytes: 8192,
        maxSearchCalls: 2,
        supports: {
          tools: false,
          vision: false,
          promptCache: true,
          reasoning: true,
          nativeSearch: true,
        },
        rates: {
          input: "1000000",
          cachedInput: "500000",
          cacheWrite5m: "2000000",
          cacheWrite1h: "4000000",
          output: "3000000",
          searchCall: "7",
        },
        pricingSource: "synthetic test-only rates",
      },
    ],
    subscriptions: [],
    topups: [
      {
        id: "test-topup",
        productId: "00000000-0000-4000-8000-000000000101",
        units: "30",
        expiresDays: 1,
      },
    ],
    limits: {
      requestTimeoutMs: 30000,
      unknownHoldSeconds: 60,
      globalConcurrent: 10,
      providers,
    },
    ...overrides,
  });
}

export async function createCloudAccount(
  db: Database,
): Promise<{ userId: string; sessionId: string }> {
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await db.sql`INSERT INTO auth_user(id,name,email,email_verified) VALUES (${userId},'Cloud Test',${`${userId}@example.test`},true)`;
  await db.sql`INSERT INTO auth_session(id,token,user_id,expires_at) VALUES (${sessionId},${crypto.randomUUID()},${userId},now()+interval '1 day')`;
  return { userId, sessionId };
}
