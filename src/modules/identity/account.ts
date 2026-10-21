import type { TransactionSql } from "postgres";
import type { Config } from "../../platform/config";
import type { Database } from "../../platform/db";
import { AppError } from "../../platform/errors";
import { consumeActionCode, requestActionCode } from "./actions";
import type { Mailer } from "./auth";
import { createAvatarService } from "./avatars/service";
import type { AccountMutationHooks, IdentitySession } from "./contracts";
import { normalizeEmail } from "./eligibility";
import { assertMutationSession } from "./session";

export function createAccountService(
  config: Config,
  db: Database,
  mailer: Mailer,
  hooks: AccountMutationHooks,
) {
  const avatars = createAvatarService(config, db);
  function requireRecentSignIn(identity: IdentitySession) {
    if (Date.now() - new Date(identity.session.createdAt).getTime() > 600000)
      throw new AppError("reauthentication_required", 401);
  }
  const authorization = (identity: IdentitySession) => ({
    sessionId: identity.session.id,
    beforeAccountMutation: hooks.beforeAccountMutation,
  });
  const account = (identity: IdentitySession) => {
    const u = identity.user;
    return {
      id: u.id,
      email: u.email,
      name: u.name?.trim() || null,
      emailVerified: u.emailVerified,
      createdAt: u.createdAt,
    };
  };
  async function sessions(identity: IdentitySession) {
    const rows =
      await db.sql`SELECT id,device,created_at,updated_at,expires_at FROM auth_session WHERE user_id=${identity.user.id} AND expires_at>now() ORDER BY created_at DESC LIMIT 100`;
    return rows.map((row) => ({
      id: row.id,
      device: row.device ?? null,
      current: row.id === identity.session.id,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
    }));
  }
  async function mutate<T>(identity: IdentitySession, effect: (tx: TransactionSql) => Promise<T>) {
    return db.sql.begin(async (tx) => {
      const [user] =
        await tx`SELECT lifecycle FROM auth_user WHERE id=${identity.user.id} FOR UPDATE`;
      if (user?.lifecycle !== "active") throw new AppError("account_unavailable", 403);
      await assertMutationSession(tx, identity.user.id, identity.session.id);
      return effect(tx);
    });
  }
  return {
    avatars,
    async account(identity: IdentitySession) {
      return { ...account(identity), ...(await avatars.profile(identity.user.id)) };
    },
    sessions,
    async updateProfile(identity: IdentitySession, name: string | null) {
      await mutate(identity, async (tx) => {
        await tx`UPDATE auth_user SET name=${name ?? ""},updated_at=clock_timestamp() WHERE id=${identity.user.id}`;
      });
      return { name };
    },
    async exportAccount(identity: IdentitySession) {
      const { emailVerified: _verified, ...u } = account(identity);
      return {
        schemaVersion: 1,
        account: { ...u, ...(await avatars.export(identity.user.id)) },
        ...(await hooks.exportExtras(identity.user.id)),
        usage_history_url: "/v1/usage/requests",
        sessions: await sessions(identity),
      };
    },
    async revokeSession(identity: IdentitySession, id: string) {
      await mutate(identity, async (tx) => {
        await tx`DELETE FROM auth_session WHERE id=${id} AND user_id=${identity.user.id}`;
      });
    },
    async revokeAll(identity: IdentitySession) {
      await mutate(identity, async (tx) => {
        await tx`DELETE FROM auth_session WHERE user_id=${identity.user.id}`;
      });
    },
    requestDeletion(identity: IdentitySession) {
      return requestActionCode(
        config,
        db,
        mailer,
        { userId: identity.user.id, purpose: "deletion" },
        authorization(identity),
      );
    },
    async confirmDeletion(identity: IdentitySession, otp: string) {
      await consumeActionCode(
        config,
        db,
        { userId: identity.user.id, purpose: "deletion", otp },
        async (tx) => {
          const [current] = await tx`SELECT email FROM auth_user WHERE id=${identity.user.id}`;
          await tx`UPDATE auth_user SET lifecycle='deleting',updated_at=clock_timestamp() WHERE id=${identity.user.id}`;
          await tx`DELETE FROM account_avatar WHERE user_id=${identity.user.id}`;
          await tx`DELETE FROM auth_session WHERE user_id=${identity.user.id}`;
          for (const purpose of ["sign-in", "email-verification", "forget-password"])
            await tx`DELETE FROM auth_verification WHERE identifier=${`${purpose}-otp-${current?.email}`}`;
          await tx`DELETE FROM action_otp WHERE owner_user_id=${identity.user.id}`;
          await tx`INSERT INTO account_deletion(user_id) VALUES (${identity.user.id}) ON CONFLICT DO NOTHING`;
          await hooks.onDeletionRequested(tx, identity.user.id);
        },
        authorization(identity),
      );
    },
    async requestEmailChange(identity: IdentitySession, email: string) {
      requireRecentSignIn(identity);
      return requestActionCode(
        config,
        db,
        mailer,
        { userId: identity.user.id, purpose: "email-change", destinationEmail: email },
        authorization(identity),
      );
    },
    async confirmEmailChange(identity: IdentitySession, email: string, otp: string) {
      requireRecentSignIn(identity);
      const normalized = normalizeEmail(email);
      await consumeActionCode(
        config,
        db,
        { userId: identity.user.id, purpose: "email-change", destinationEmail: normalized, otp },
        async (tx) => {
          const [current] = await tx`SELECT email FROM auth_user WHERE id=${identity.user.id}`;
          const [other] =
            await tx`SELECT id FROM auth_user WHERE email=${normalized} AND id<>${identity.user.id}`;
          if (other) throw new AppError("email_unavailable", 409);
          await tx`UPDATE auth_user SET email=${normalized},email_verified=true,updated_at=clock_timestamp() WHERE id=${identity.user.id}`;
          await hooks.onEmailChanged(tx, identity.user.id);
          await tx`DELETE FROM auth_session WHERE user_id=${identity.user.id}`;
          await tx`DELETE FROM auth_verification WHERE identifier IN (${`sign-in-otp-${current?.email}`},${`sign-in-otp-${normalized}`})`;
        },
        authorization(identity),
      );
    },
  };
}
export type AccountService = ReturnType<typeof createAccountService>;
