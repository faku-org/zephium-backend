import type { TransactionSql } from "postgres";
import type { Auth } from "./auth";

export type IdentitySession = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
export type IdentityEnvironment = { Variables: { identity: IdentitySession } };
export type AccountMutationHooks = {
  beforeAccountMutation(tx: TransactionSql, userId: string): Promise<void>;
  onDeletionRequested(tx: TransactionSql, userId: string): Promise<void>;
  exportExtras(userId: string): Promise<{ billing: unknown; usage: unknown }>;
};
