import type { Config } from "../../platform/config";
import { normalizeEmail } from "./eligibility";

/** An empty allowlist permits all addresses. Entries are exact, including aliases. */
export function signupEmailAllowed(config: Config, email: string): boolean {
  const addresses = config.SIGNUP_EMAIL_ALLOWLIST.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return addresses.length === 0 || addresses.includes(normalizeEmail(email));
}
