import { enforce, privateKey } from "../../platform/abuse";
import type { Config } from "../../platform/config";
import type { Database } from "../../platform/db";
import { emailNetwork } from "../../platform/ip-bucket";

/** Checked before account lookup, with the same response for existing and new emails. */
export function limitSignInSend(config: Config, db: Database, address: string): Promise<void> {
  return enforce(
    db,
    privateKey(config.ABUSE_SECRET, "otp-network:v1", emailNetwork(address)),
    900,
    config.OTP_SENDS_PER_NETWORK_PER_15_MIN,
  );
}

/** Shared across API replicas and purposes. Admit BEFORE account-dependent suppression. */
export function admitEmailSend(config: Config, db: Database): Promise<void> {
  return enforce(
    db,
    privateKey(config.ABUSE_SECRET, "otp-delivery-minute:v1", "all"),
    60,
    config.EMAIL_SENDS_PER_MINUTE,
  );
}
