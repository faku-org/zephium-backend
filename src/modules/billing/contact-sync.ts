import type { Database } from "../../platform/db";
import { operationalEvent } from "../../platform/errors";
import { pendingPlanChange } from "./plan-changes";
import type { BillingProvider } from "./provider";

/** Contact retries must never exhaust subscription reconciliation or alter entitlement. */
export async function processContactSync(
  db: Database,
  provider: BillingProvider,
): Promise<boolean> {
  return db.sql.begin(async (tx) => {
    // Match identity's billing -> account -> contact-job lock order. The verified
    // address is read after the billing lock, so rapid changes coalesce safely.
    const [candidate] = await tx`SELECT b.user_id FROM billing_contact_job j
      JOIN billing_customer b ON b.user_id=j.user_id JOIN auth_user u ON u.id=j.user_id
      WHERE u.lifecycle='active' AND u.email_verified AND j.requested>j.processed AND j.attempts<10 AND j.next_attempt<=now()
      AND NOT EXISTS(SELECT 1 FROM billing_plan_change c WHERE c.user_id=j.user_id AND c.state IN ('queued','executing','uncertain'))
      ORDER BY j.next_attempt FOR UPDATE OF b SKIP LOCKED LIMIT 1`;
    if (!candidate || (await pendingPlanChange(tx, candidate.user_id))) return false;
    const [account] =
      await tx`SELECT email,email_verified,lifecycle FROM auth_user WHERE id=${candidate.user_id}`;
    if (account?.lifecycle !== "active" || !account.email_verified) return false;
    const [job] =
      await tx`SELECT * FROM billing_contact_job WHERE user_id=${candidate.user_id} FOR UPDATE`;
    if (!job || job.requested <= job.processed || job.attempts >= 10) return false;
    try {
      const state = await provider.state(candidate.user_id);
      if (state) {
        if (state.accountId !== candidate.user_id) throw new Error("Contact identity mismatch");
        if (state.email === undefined) throw new Error("Contact state unavailable");
        if (state.email?.trim().toLowerCase() !== String(account.email).trim().toLowerCase()) {
          if (!provider.updateCustomerEmail) throw new Error("Contact update unavailable");
          // Setting one verified address by stable external ID is idempotent.
          // After an ambiguous response, the next state read may already match.
          await provider.updateCustomerEmail(candidate.user_id, account.email);
        }
      }
      // A customer that does not exist is never created by contact synchronization.
      await tx`UPDATE billing_contact_job SET processed=${job.requested},attempts=0 WHERE user_id=${candidate.user_id}`;
    } catch {
      const attempts = Number(job.attempts) + 1;
      await tx`UPDATE billing_contact_job SET attempts=${attempts},next_attempt=now()+${Math.min(3600, 15 * 2 ** attempts)}*interval '1 second' WHERE user_id=${candidate.user_id}`;
      operationalEvent(attempts >= 10 ? "billing_contact_exhausted" : "billing_contact_retry");
    }
    return true;
  }) as Promise<boolean>;
}
