import type { TransactionSql } from "postgres";

/** Durable identity history survives account deletion and is shared by email aliases. */
export type GrantEligibility = {
  free_anchor: string | null;
  free_period_end: string | null;
  welcome_claimed_at: string | null;
  signup_claimed_at: string | null;
};

/** Caller supplies its existing transaction and acquires this after its wallet lock. */
export async function lockGrantEligibility(
  tx: TransactionSql,
  key: string,
): Promise<GrantEligibility | undefined> {
  await tx`INSERT INTO email_eligibility(key) VALUES (${key}) ON CONFLICT DO NOTHING`;
  const [eligibility] = await tx<
    GrantEligibility[]
  >`SELECT * FROM email_eligibility WHERE key=${key} FOR UPDATE`;
  return eligibility;
}

export async function markSignupClaimed(tx: TransactionSql, key: string, at: Date): Promise<void> {
  await tx`UPDATE email_eligibility SET signup_claimed_at=${at.toISOString()} WHERE key=${key}`;
}

export async function markWelcomeClaimed(tx: TransactionSql, key: string, at: Date): Promise<void> {
  await tx`UPDATE email_eligibility SET welcome_claimed_at=${at.toISOString()}::timestamptz WHERE key=${key}`;
}

export async function setFreeAnchor(tx: TransactionSql, key: string, at: Date): Promise<void> {
  await tx`UPDATE email_eligibility SET free_anchor=${at.toISOString()}::timestamptz WHERE key=${key}`;
}

export async function markFreePeriod(tx: TransactionSql, key: string, end: Date): Promise<void> {
  await tx`UPDATE email_eligibility SET free_period_end=${end.toISOString()}::timestamptz WHERE key=${key}`;
}
