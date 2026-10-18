import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true });

import { user } from "../identity/schema";
import { cloudPolicy } from "../policy/schema";

export const creditWallet = pgTable(
  "credit_wallet",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    anchor: time("anchor").notNull().defaultNow(),
    welcomedAt: time("welcomed_at"),
    dailyLimitUnits: bigint("daily_limit_units", { mode: "bigint" }),
    suspended: boolean("suspended").notNull().default(false),
  },
  (t) => [check("credit_wallet_daily_limit_units_check", sql`${t.dailyLimitUnits} >= 0`)],
);

export const creditGrant = pgTable(
  "credit_grant",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => creditWallet.userId, { onDelete: "cascade" }),
    grantKey: text("grant_key").notNull(),
    kind: text("kind").notNull(),
    policyRevision: integer("policy_revision")
      .notNull()
      .references(() => cloudPolicy.revision),
    planId: text("plan_id"),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    spent: bigint("spent", { mode: "bigint" }).notNull().default(0n),
    held: bigint("held", { mode: "bigint" }).notNull().default(0n),
    revoked: boolean("revoked").notNull().default(false),
    periodStart: time("period_start"),
    expiresAt: time("expires_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("credit_grant_user_id_grant_key_key").on(t.userId, t.grantKey),
    index("credit_grant_owner").on(t.userId, t.expiresAt),
    check("credit_grant_kind_check", sql`${t.kind} in ('welcome', 'included', 'topup')`),
    check("credit_grant_amount_check", sql`${t.amount} >= 0`),
    check("credit_grant_spent_check", sql`${t.spent} >= 0`),
    check("credit_grant_held_check", sql`${t.held} >= 0`),
    check("credit_grant_balance_check", sql`${t.spent} + ${t.held} <= ${t.amount}`),
  ],
);

export const cloudRequest = pgTable(
  "cloud_request",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => creditWallet.userId, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    clientKey: text("client_key").notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    route: text("route").notNull(),
    policyRevision: integer("policy_revision")
      .notNull()
      .references(() => cloudPolicy.revision),
    costRates: jsonb("cost_rates").$type<Record<string, unknown>>(),
    planId: text("plan_id"),
    fundingSource: text("funding_source"),
    dispatchedAt: time("dispatched_at"),
    priceSnapshot: jsonb("price_snapshot").$type<Record<string, unknown>>().notNull(),
    state: text("state").notNull(),
    reserved: bigint("reserved", { mode: "bigint" }).notNull().default(0n),
    reservedAt: time("reserved_at"),
    charged: bigint("charged", { mode: "bigint" }).notNull().default(0n),
    actualCost: bigint("actual_cost", { mode: "bigint" }),
    usage: jsonb("usage").$type<Record<string, unknown>>(),
    errorClass: text("error_class"),
    upstreamRequestId: text("upstream_request_id"),
    upstreamStatus: integer("upstream_status"),
    startedAt: time("started_at").notNull().defaultNow(),
    finishedAt: time("finished_at"),
    leaseUntil: time("lease_until").notNull(),
    holdUntil: time("hold_until").notNull(),
  },
  (t) => [
    unique("cloud_request_user_id_client_key_key").on(t.userId, t.clientKey),
    index("cloud_request_live").on(t.userId, t.state, t.leaseUntil),
    index("cloud_request_recovery").on(t.state, t.holdUntil),
    check(
      "cloud_request_state_check",
      sql`${t.state} in ('preflight', 'reserved', 'running', 'usage_unknown', 'settled', 'released')`,
    ),
    check("cloud_request_reserved_check", sql`${t.reserved} >= 0`),
    check("cloud_request_charged_check", sql`${t.charged} >= 0`),
  ],
);

export const creditAllocation = pgTable(
  "credit_allocation",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => cloudRequest.id, { onDelete: "cascade" }),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => creditGrant.id, { onDelete: "cascade" }),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.requestId, t.grantId] }),
    check("credit_allocation_amount_check", sql`${t.amount} > 0`),
  ],
);

export const providerBucket = pgTable("provider_bucket", {
  provider: text("provider").primaryKey(),
  requests: doublePrecision("requests").notNull(),
  tokens: doublePrecision("tokens").notNull(),
  updatedAt: time("updated_at").notNull(),
});

export const cloudOutbox = pgTable(
  "cloud_outbox",
  {
    requestId: uuid("request_id")
      .primaryKey()
      .references(() => cloudRequest.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttempt: time("next_attempt").notNull().defaultNow(),
    deliveredAt: time("delivered_at"),
  },
  (t) => [index("cloud_outbox_pending").on(t.nextAttempt).where(sql`${t.deliveredAt} is null`)],
);

export const cloudSpendBucket = pgTable(
  "cloud_spend_bucket",
  {
    key: text("key").primaryKey(),
    amount: bigint("amount", { mode: "bigint" }).notNull().default(0n),
  },
  (t) => [check("cloud_spend_bucket_amount_check", sql`${t.amount} >= 0`)],
);

export const cloudCostRecord = pgTable("cloud_cost_record", {
  requestId: uuid("request_id").primaryKey(),
  scope: text("scope").notNull(),
  day: date("day").notNull(),
  reserved: bigint("reserved", { mode: "bigint" }).notNull(),
  exposure: bigint("exposure", { mode: "bigint" }).notNull(),
  freeReserved: bigint("free_reserved", { mode: "bigint" }).notNull(),
  freeExposure: bigint("free_exposure", { mode: "bigint" }).notNull(),
  terminal: boolean("terminal").notNull().default(false),
});
