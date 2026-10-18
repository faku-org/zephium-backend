import type { TransactionSql } from "postgres";
import { z } from "zod";
import { privateKey } from "../../platform/abuse";

const address = z.email().max(254);

/** Identity normalization is deliberately limited to whitespace and case. */
export function normalizeEmail(value: string): string {
  return address.parse(value.trim().toLowerCase());
}

/** Stable pseudonymous key retained after account deletion. */
export function eligibilityKey(secret: string, email: string): string {
  return privateKey(secret, "email-eligibility", normalizeEmail(email));
}

export function eligibilitySecret(config: {
  NODE_ENV: string;
  ABUSE_SECRET: string;
  AUTH_SECRET: string;
  DEPLOYMENT_MODE: "hosted" | "self_hosted";
  ELIGIBILITY_SECRET?: string;
}): string {
  if (config.ELIGIBILITY_SECRET) return config.ELIGIBILITY_SECRET;
  if (config.NODE_ENV !== "production") return config.ABUSE_SECRET;
  if (config.DEPLOYMENT_MODE === "self_hosted") return config.AUTH_SECRET;
  throw new Error("Hosted production requires ELIGIBILITY_SECRET");
}

/** Alias links are flattened to a canonical row; no recursive lookup is needed. */
export async function resolveEligibilityKey(
  tx: TransactionSql,
  secret: string,
  email: string,
): Promise<string> {
  const key = eligibilityKey(secret, email);
  await tx`INSERT INTO email_eligibility(key) VALUES (${key}) ON CONFLICT DO NOTHING`;
  const [alias] =
    await tx`SELECT canonical_key FROM email_eligibility_alias WHERE alias_key=${key}`;
  return alias?.canonical_key ?? key;
}
