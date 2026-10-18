import type { Database } from "../../platform/db";

interface HistoryRow {
  id: string;
  model_id: string;
  state: string;
  units: string;
  reserved: string;
  funding_source: string | null;
  started_at: Date;
  finished_at: Date | null;
}
interface ReceiptRow {
  id: string;
  state: string;
  model_id: string;
  policy_revision: number;
  reserved: string;
  charged: string;
  funding_source: string | null;
  error_class: string | null;
  started_at: Date;
  finished_at: Date | null;
}
export interface UsageCursor {
  time: string;
  id: string;
}

/** Account-scoped history. Payloads and provider responses never belong in this projection. */
export async function usageHistory(db: Database, userId: string, cursor?: UsageCursor) {
  const rows = cursor
    ? await db.sql<
        HistoryRow[]
      >`SELECT id,model_id,state,charged::text AS units,reserved::text,funding_source,started_at,finished_at FROM cloud_request WHERE user_id=${userId} AND (started_at,id)<(${cursor.time}::timestamptz,${cursor.id}::uuid) ORDER BY started_at DESC,id DESC LIMIT 51`
    : await db.sql<
        HistoryRow[]
      >`SELECT id,model_id,state,charged::text AS units,reserved::text,funding_source,started_at,finished_at FROM cloud_request WHERE user_id=${userId} ORDER BY started_at DESC,id DESC LIMIT 51`;
  const visible = rows.slice(0, 50);
  const last = visible.at(-1);
  return {
    requests: visible.map((row) => ({
      ...row,
      started_at: new Date(row.started_at).toISOString(),
      finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    })),
    next_cursor:
      rows.length > 50 && last
        ? Buffer.from(
            JSON.stringify({ time: new Date(last.started_at).toISOString(), id: last.id }),
          ).toString("base64url")
        : null,
  };
}

/** Used by receipt HTTP handlers and AI completion trailers through the same user boundary. */
export async function requestReceipt(db: Database, userId: string, id: string) {
  const [row] = await db.sql<
    ReceiptRow[]
  >`SELECT id,state,model_id,policy_revision,reserved::text,charged::text,funding_source,error_class,started_at,finished_at FROM cloud_request WHERE id=${id} AND user_id=${userId}`;
  if (!row) return null;
  return {
    ...row,
    started_at: new Date(row.started_at).toISOString(),
    finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
  };
}
