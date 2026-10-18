import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true });

export const cloudPolicy = pgTable("cloud_policy", {
  revision: integer("revision").primaryKey(),
  digest: text("digest").notNull(),
  configuration: jsonb("configuration").$type<Record<string, unknown>>().notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
});

export const cloudActivePolicy = pgTable(
  "cloud_active_policy",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    revision: integer("revision")
      .notNull()
      .references(() => cloudPolicy.revision),
  },
  (t) => [check("cloud_active_policy_singleton_check", sql`${t.singleton}`)],
);
