import { createHmac } from "node:crypto";
import type { Database } from "./db";
import { AppError } from "./errors";

export function privateKey(secret: string, kind: string, value: string): string {
  return createHmac("sha256", secret).update(`${kind}\0${value}`).digest("hex");
}
/** Atomic fixed windows; no raw IPs/emails are persisted. Expired buckets are pruned. */
export async function consume(db: Pick<Database, "sql">, key: string, window: number, max: number) {
  const [row] = await db.sql<{ count: number; retry_after: number }[]>`
    INSERT INTO abuse_bucket (key, count, expires_at) VALUES (${key}, 1, now() + ${window} * interval '1 second')
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN abuse_bucket.expires_at <= now() THEN 1 ELSE LEAST(abuse_bucket.count + 1, ${max + 1}) END,
      expires_at = CASE WHEN abuse_bucket.expires_at <= now() THEN now() + ${window} * interval '1 second' ELSE abuse_bucket.expires_at END
    RETURNING count, greatest(1, ceil(extract(epoch FROM expires_at - now())))::integer AS retry_after`;
  if (!row) throw new AppError("unavailable", 503);
  return { allowed: row.count <= max, retryAfter: row.count <= max ? null : row.retry_after };
}
export async function enforce(db: Pick<Database, "sql">, key: string, window: number, max: number) {
  const result = await consume(db, key, window, max);
  if (!result.allowed) throw new AppError("rate_limited", 429, result.retryAfter ?? 1);
}

/** Providers can use either delay seconds or an HTTP-date. Never relay arbitrary headers. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - now) / 1000)) : undefined;
}
