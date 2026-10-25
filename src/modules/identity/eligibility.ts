import type { TransactionSql } from "postgres";
import { z } from "zod";
import { privateKey } from "../../platform/abuse";
import { bindGrantMailbox, lockGrantGrouping } from "./grant-mailboxes";

const address = z.email().max(254);

/** Identity normalization is deliberately limited to whitespace and case. */
export function normalizeEmail(value: string): string {
  return address.parse(value.trim().toLowerCase());
}

/** Stable pseudonymous key retained after account deletion. */
export function eligibilityKey(secret: string, email: string): string {
  return privateKey(secret, "email-eligibility", normalizeEmail(email));
}

/** Versioned trial grouping only. Never use this value for login or mail delivery. */
export function grantMailboxKey(secret: string, email: string): string | null {
  const normalized = normalizeEmail(email);
  const [local, domain] = normalized.split("@");
  if (domain !== "gmail.com" && domain !== "googlemail.com") return null;
  const mailbox = local?.split("+")[0]?.replaceAll(".", "");
  // Invalid provider-specific local parts must not collapse into a common empty key.
  if (!mailbox) return null;
  return privateKey(secret, "grant-mailbox:gmail:v1", `${mailbox}@gmail.com`);
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

/** Alias links are flattened. Caller holds the email and account locks before
 * creating a binding; ordinary sign-in never needs the exclusive grouping fence. */
export async function resolveEligibilityKey(
  tx: TransactionSql,
  secret: string,
  email: string,
): Promise<string> {
  const key = eligibilityKey(secret, email);
  const mailbox = grantMailboxKey(secret, email);
  await tx`INSERT INTO email_eligibility(key) VALUES (${key}) ON CONFLICT DO NOTHING`;
  const [alias] =
    await tx`SELECT canonical_key FROM email_eligibility_alias WHERE alias_key=${key}`;
  const identity = alias?.canonical_key ?? key;
  if (!mailbox) return identity;
  // One statement observes a consistent mapping snapshot. A concurrent merge
  // moves both references atomically and preserves their equivalence, so an
  // already-bound mailbox requires no grouping mutation or exclusive lock.
  const [bound] = await tx`SELECT 1 FROM grant_eligibility_member m
    JOIN grant_eligibility_mailbox b ON b.group_key=m.group_key
    WHERE m.identity_key=${identity} AND b.mailbox_key=${mailbox}`;
  if (bound) return identity;
  await lockGrantGrouping(tx);
  // Recheck mappings under the fence: another alias can have bound or merged
  // this mailbox since the read above.
  await bindGrantMailbox(tx, identity, mailbox);
  return identity;
}
