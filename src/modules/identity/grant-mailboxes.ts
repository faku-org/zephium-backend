import type { TransactionSql } from "postgres";
import type { Database } from "../../platform/db";

// Association changes are rare. Readers share this fence and then serialize only
// within a grant group. Acquire it AFTER account/wallet locks, BEFORE eligibility
// rows. Association must never acquire another account or wallet after this fence.
const fence = 91843723;
export async function lockGrantGrouping(tx: TransactionSql): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(${fence})`;
}
export async function lockGrantGroupingRead(tx: TransactionSql): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock_shared(${fence})`;
}

export async function assertGrantEligibilityReady(db: Database): Promise<void> {
  const [state] = await db.sql`SELECT complete FROM grant_eligibility_migration WHERE version=1`;
  if (!state?.complete)
    throw new Error(
      "Grant eligibility requires offline backfill: bun scripts/backfill-grant-eligibility.ts",
    );
}

/** Import authoritative identity histories; former email aliases resolve to these roots. */
export async function refreshGrantGroup(tx: TransactionSql, group: string): Promise<void> {
  await tx`UPDATE grant_eligibility_group g SET
    welcome_claimed_at=least(g.welcome_claimed_at,h.welcome_claimed_at),
    signup_claimed_at=least(g.signup_claimed_at,h.signup_claimed_at),
    free_anchor=least(g.free_anchor,h.free_anchor),
    free_period_end=greatest(g.free_period_end,h.free_period_end)
    FROM (SELECT min(e.welcome_claimed_at) AS welcome_claimed_at,
      min(e.signup_claimed_at) AS signup_claimed_at,min(e.free_anchor) AS free_anchor,
      max(e.free_period_end) AS free_period_end FROM email_eligibility e
      WHERE e.key IN (SELECT identity_key FROM grant_eligibility_member WHERE group_key=${group})
    ) h WHERE g.key=${group}`;
}

/** Caller holds the exclusive grouping fence. Groups contain no account identity. */
export async function bindGrantMailbox(
  tx: TransactionSql,
  identity: string,
  mailbox: string | null,
): Promise<void> {
  if (!mailbox) return;
  const [member] =
    await tx`SELECT group_key FROM grant_eligibility_member WHERE identity_key=${identity}`;
  const own = member?.group_key ?? identity;
  await tx`INSERT INTO grant_eligibility_group(key) VALUES (${own}) ON CONFLICT DO NOTHING`;
  await tx`INSERT INTO grant_eligibility_member(identity_key,group_key) VALUES (${identity},${own}) ON CONFLICT DO NOTHING`;
  const [existing] =
    await tx`SELECT group_key FROM grant_eligibility_mailbox WHERE mailbox_key=${mailbox}`;
  const other = existing?.group_key ?? own;
  if (own !== other) {
    const keep = own < other ? own : other;
    const remove = own < other ? other : own;
    await tx`UPDATE grant_eligibility_group g SET
      welcome_claimed_at=least(g.welcome_claimed_at,h.welcome_claimed_at),
      signup_claimed_at=least(g.signup_claimed_at,h.signup_claimed_at),
      free_anchor=least(g.free_anchor,h.free_anchor),
      free_period_end=greatest(g.free_period_end,h.free_period_end)
      FROM grant_eligibility_group h WHERE g.key=${keep} AND h.key=${remove}`;
    await tx`UPDATE grant_eligibility_member SET group_key=${keep} WHERE group_key=${remove}`;
    await tx`UPDATE grant_eligibility_mailbox SET group_key=${keep} WHERE group_key=${remove}`;
    await tx`DELETE FROM grant_eligibility_group WHERE key=${remove}`;
    await tx`INSERT INTO grant_eligibility_mailbox(mailbox_key,group_key) VALUES (${mailbox},${keep}) ON CONFLICT DO NOTHING`;
    await refreshGrantGroup(tx, keep);
  } else {
    await tx`INSERT INTO grant_eligibility_mailbox(mailbox_key,group_key) VALUES (${mailbox},${own}) ON CONFLICT DO NOTHING`;
    await refreshGrantGroup(tx, own);
  }
}
