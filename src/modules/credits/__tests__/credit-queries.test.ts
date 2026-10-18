import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { createCloudAccount, testPolicy } from "../../../../tests/support/cloud-fixture";
import { testDatabase } from "../../../../tests/support/database";
import { AppError, errorResponse } from "../../../platform/errors";
import type { IdentityEnvironment } from "../../identity/contracts";
import { registerPolicy } from "../../policy/policy";
import { createCreditRoutes, requestReceipt, usageHistory } from "..";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const policy = testPolicy();
let owner: Awaited<ReturnType<typeof createCloudAccount>>;
let other: Awaited<ReturnType<typeof createCloudAccount>>;
const ids: string[] = [];
const time = "2026-10-18T12:00:00.000Z";
beforeAll(async () => {
  fixture = await testDatabase();
  await registerPolicy(fixture.db, policy);
  owner = await createCloudAccount(fixture.db);
  other = await createCloudAccount(fixture.db);
  await fixture.db
    .sql`INSERT INTO credit_wallet(user_id) VALUES (${owner.userId}),(${other.userId})`;
  for (let i = 0; i < 52; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    await fixture.db
      .sql`INSERT INTO cloud_request(id,user_id,session_id,client_key,provider,model_id,route,policy_revision,price_snapshot,state,charged,funding_source,started_at,finished_at,lease_until,hold_until) VALUES (${id},${owner.userId},${owner.sessionId},${crypto.randomUUID()},'openai','test-model','openai',${policy.revision},'{}'::jsonb,'settled',${String(i)},'allowance',${time},${time},now(),now())`;
  }
}, 30000);
afterAll(async () => {
  await fixture?.close();
});

test("credit history paginates equal timestamps without duplication and scopes every query to its owner", async () => {
  const expected = [...ids].sort().reverse();
  const first = await usageHistory(fixture.db, owner.userId);
  expect(first.requests.map((r) => r.id)).toEqual(expected.slice(0, 50));
  expect(first.requests[0]?.started_at).toBe(time);
  expect(first.requests[0]?.finished_at).toBe(time);
  expect(first.next_cursor).not.toBeNull();
  const cursor = JSON.parse(Buffer.from(first.next_cursor ?? "", "base64url").toString());
  const second = await usageHistory(fixture.db, owner.userId, cursor);
  expect(second.requests.map((r) => r.id)).toEqual(expected.slice(50));
  expect(second.next_cursor).toBeNull();
  expect(await usageHistory(fixture.db, other.userId)).toEqual({ requests: [], next_cursor: null });
  const id = ids[0];
  if (!id) throw new Error("Missing fixture request");
  const receipt = await requestReceipt(fixture.db, owner.userId, id);
  expect(receipt).toMatchObject({
    id,
    model_id: "test-model",
    state: "settled",
    charged: "0",
    funding_source: "allowance",
    started_at: time,
    finished_at: time,
  });
  expect(await requestReceipt(fixture.db, other.userId, id)).toBeNull();
  expect(await requestReceipt(fixture.db, owner.userId, crypto.randomUUID())).toBeNull();
});

test("credit HTTP routes preserve history and receipt shapes and reject invalid cursors", async () => {
  const app = new Hono<IdentityEnvironment>();
  app.use("*", async (c, next) => {
    c.set("identity", {
      user: { id: owner.userId },
      session: { id: owner.sessionId },
    } as IdentityEnvironment["Variables"]["identity"]);
    await next();
  });
  app.route("/", createCreditRoutes(fixture.db, policy));
  app.onError((error) =>
    errorResponse(error instanceof AppError ? error : new AppError("invalid_request")),
  );
  const history = await app.request("/v1/usage/requests");
  expect(history.status).toBe(200);
  expect((await history.json()).requests).toHaveLength(50);
  const id = ids[0];
  if (!id) throw new Error("Missing fixture request");
  const response = await app.request(`/v1/usage/requests/${id}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id,
    charged: "0",
    policy_revision: policy.revision,
  });
  expect((await app.request("/v1/usage/requests?cursor=not-a-cursor")).status).toBe(400);
  const missing = await app.request(`/v1/usage/requests/${crypto.randomUUID()}`);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: { code: "not_found" }, request_id: null });
});
