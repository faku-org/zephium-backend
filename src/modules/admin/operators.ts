import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import type { AdminAuthDatabase } from "./auth";

/** Local provisioning only. No HTTP signup or password-reset endpoint is exposed. */
export async function provisionAdminOperator(
  db: AdminAuthDatabase,
  email: string,
  name: string,
  password: string,
): Promise<void> {
  const input = z
    .object({
      email: z
        .email()
        .max(254)
        .transform((value) => value.toLowerCase()),
      name: z.string().trim().min(1).max(100),
      password: z.string().min(16).max(128),
    })
    .parse({ email, name, password });
  const passwordHash = await hashPassword(input.password);
  await db.sql.begin(async (tx) => {
    const id = randomUUID();
    await tx`INSERT INTO admin_auth_user (id,name,email,email_verified)
      VALUES (${id},${input.name},${input.email},true)`;
    await tx`INSERT INTO admin_auth_account (id,account_id,provider_id,user_id,password)
      VALUES (${randomUUID()},${id},'credential',${id},${passwordHash})`;
  });
}

async function changeOperator(
  db: AdminAuthDatabase,
  action: "disable" | "revoke" | "reset-password",
  email: string,
  password?: string,
): Promise<void> {
  const normalizedEmail = z.email().max(254).parse(email).toLowerCase();
  const passwordHash =
    action === "reset-password"
      ? await hashPassword(z.string().min(16).max(128).parse(password))
      : undefined;
  await db.sql.begin(async (tx) => {
    const [operator] =
      await tx`SELECT id FROM admin_auth_user WHERE email=${normalizedEmail} FOR UPDATE`;
    if (!operator) throw new Error("operator_not_found");
    if (action === "disable") {
      await tx`UPDATE admin_auth_user SET active=false,updated_at=clock_timestamp() WHERE id=${operator.id}`;
    } else if (passwordHash) {
      const updated =
        await tx`UPDATE admin_auth_account SET password=${passwordHash},updated_at=clock_timestamp()
        WHERE user_id=${operator.id} AND provider_id='credential' RETURNING id`;
      if (updated.length !== 1) throw new Error("operator_credential_not_found");
    }
    await tx`DELETE FROM admin_auth_session WHERE user_id=${operator.id}`;
    // Better Auth stores the owner on the challenge, while its paired attempt
    // record contains only a counter. Remove both without reading any secret.
    await tx`WITH removed AS (
      DELETE FROM admin_auth_verification
      WHERE value=${operator.id} AND identifier LIKE '2fa-%' AND identifier NOT LIKE '2fa-attempts-%'
      RETURNING identifier
    ) DELETE FROM admin_auth_verification
      WHERE identifier IN (SELECT '2fa-attempts-'||identifier FROM removed)`;
  });
}

/** Immediately blocks all report access, including any concurrent session issuance. */
export function disableAdminOperator(db: AdminAuthDatabase, email: string): Promise<void> {
  return changeOperator(db, "disable", email);
}
/** Stop the admin listener first when recovery must also exclude in-flight sign-ins. */
export function revokeAdminOperator(db: AdminAuthDatabase, email: string): Promise<void> {
  return changeOperator(db, "revoke", email);
}
/** Preserves TOTP enrollment and the active/disabled flag. Local stdin command only. */
export function resetAdminOperatorPassword(
  db: AdminAuthDatabase,
  email: string,
  password: string,
): Promise<void> {
  return changeOperator(db, "reset-password", email, password);
}
