import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true });
// 0003_identity.sql keeps eligibility state without retaining an email address.
export const emailEligibility = pgTable("email_eligibility", {
  key: text("key").primaryKey(),
  welcomeClaimedAt: time("welcome_claimed_at"),
  signupClaimedAt: time("signup_claimed_at"),
  freeAnchor: time("free_anchor"),
  freePeriodEnd: time("free_period_end"),
});
export const emailEligibilityAlias = pgTable(
  "email_eligibility_alias",
  {
    aliasKey: text("alias_key")
      .primaryKey()
      .references(() => emailEligibility.key),
    canonicalKey: text("canonical_key")
      .notNull()
      .references(() => emailEligibility.key),
  },
  (t) => [index("email_eligibility_alias_canonical_idx").on(t.canonicalKey)],
);

// Grant-only mailbox grouping never changes identity or ownership.
export const grantEligibilityGroup = pgTable("grant_eligibility_group", {
  key: text("key").primaryKey(),
  welcomeClaimedAt: time("welcome_claimed_at"),
  signupClaimedAt: time("signup_claimed_at"),
  freeAnchor: time("free_anchor"),
  freePeriodEnd: time("free_period_end"),
});
export const grantEligibilityMember = pgTable(
  "grant_eligibility_member",
  {
    identityKey: text("identity_key")
      .primaryKey()
      .references(() => emailEligibility.key),
    groupKey: text("group_key")
      .notNull()
      .references(() => grantEligibilityGroup.key),
  },
  (t) => [index("grant_eligibility_member_group_idx").on(t.groupKey)],
);
export const grantEligibilityMailbox = pgTable(
  "grant_eligibility_mailbox",
  {
    mailboxKey: text("mailbox_key").primaryKey(),
    groupKey: text("group_key")
      .notNull()
      .references(() => grantEligibilityGroup.key),
  },
  (t) => [index("grant_eligibility_mailbox_group_idx").on(t.groupKey)],
);
export const grantEligibilityMigration = pgTable(
  "grant_eligibility_migration",
  {
    version: integer("version").primaryKey(),
    complete: boolean("complete").notNull(),
  },
  (t) => [check("grant_eligibility_migration_version_check", sql`${t.version} = 1`)],
);

export const user = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
  lifecycle: text("lifecycle").notNull().default("active"),
  eligibilityKey: text("eligibility_key").references(() => emailEligibility.key),
});
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
export const accountAvatar = pgTable(
  "account_avatar",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    version: uuid("version").notNull().unique(),
    content: bytea("content").notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width").notNull().default(256),
    height: integer("height").notNull().default(256),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("account_avatar_content_check", sql`octet_length(${t.content}) BETWEEN 1 AND 262144`),
    check("account_avatar_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("account_avatar_width_check", sql`${t.width} = 256`),
    check("account_avatar_height_check", sql`${t.height} = 256`),
  ],
);

export const session = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: time("expires_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    device: text("device"),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);
export const account = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: time("access_token_expires_at"),
    refreshTokenExpiresAt: time("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);
export const verification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: time("expires_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);
export const actionOtp = pgTable(
  "action_otp",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    destinationKey: text("destination_key").notNull(),
    otpHash: text("otp_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: time("expires_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerUserId, t.purpose, t.destinationKey] }),
    check("action_otp_purpose_check", sql`${t.purpose} in ('deletion', 'email-change')`),
    check("action_otp_attempts_check", sql`${t.attempts} between 0 and 5`),
    index("action_otp_expiry_idx").on(t.expiresAt),
  ],
);
