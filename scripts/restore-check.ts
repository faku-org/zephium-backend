import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { applyTopup } from "../src/modules/credits/grants";
import { processAvatar } from "../src/modules/identity/avatars/processor";
import { createDatabase, type Database } from "../src/platform/db";
import { testPolicy } from "../tests/support/cloud-fixture";
import { testDatabase } from "../tests/support/database";

const fixture = await testDatabase();
const bin = process.env.PG_TOOLS ?? resolve(".local/postgres-tools/bin");
const original = new URL(fixture.config.DATABASE_URL);
const password = original.password;
original.password = "";
const run = async (command: string[]) => {
  const p = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PGPASSWORD: password },
  });
  const timer = setTimeout(() => p.kill(), 60000);
  try {
    const [code] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    if (code !== 0) throw new Error("Database backup/restore command failed");
  } finally {
    clearTimeout(timer);
  }
};

async function snapshot(db: Database, userId: string) {
  return {
    account:
      await db.sql`SELECT u.*, b.* FROM auth_user u JOIN billing_customer b ON b.user_id=u.id WHERE u.id=${userId}`,
    migrations: await db.sql`SELECT name,digest FROM schema_migration ORDER BY name`,
    avatars:
      await db.sql`SELECT user_id,version,encode(content,'hex') AS content_hex,sha256,width,height,updated_at FROM account_avatar WHERE user_id=${userId}`,
    eligibility: await db.sql`SELECT * FROM email_eligibility ORDER BY key`,
    aliases: await db.sql`SELECT * FROM email_eligibility_alias ORDER BY alias_key`,
    actions: await db.sql`SELECT * FROM action_otp WHERE owner_user_id=${userId}`,
    checkouts: await db.sql`SELECT * FROM billing_checkout WHERE user_id=${userId}`,
    reversals:
      await db.sql`SELECT * FROM billing_order_reversal WHERE user_id=${userId} ORDER BY order_id`,
    policy: await db.sql`SELECT * FROM cloud_policy ORDER BY revision`,
    activePolicy: await db.sql`SELECT * FROM cloud_active_policy`,
    wallet: await db.sql`SELECT * FROM credit_wallet WHERE user_id=${userId}`,
    grants: await db.sql`SELECT * FROM credit_grant WHERE user_id=${userId} ORDER BY grant_key`,
    requests: await db.sql`SELECT * FROM cloud_request WHERE user_id=${userId} ORDER BY client_key`,
    allocations:
      await db.sql`SELECT a.* FROM credit_allocation a JOIN cloud_request r ON r.id=a.request_id WHERE r.user_id=${userId} ORDER BY a.request_id,a.grant_id`,
    providerBuckets: await db.sql`SELECT * FROM provider_bucket ORDER BY provider`,
    spendBuckets: await db.sql`SELECT * FROM cloud_spend_bucket ORDER BY key`,
    // Deliberately global: unknown exposure survives deletion of its originating account.
    costRecords: await db.sql`SELECT * FROM cloud_cost_record ORDER BY request_id`,
    outbox:
      await db.sql`SELECT o.* FROM cloud_outbox o JOIN cloud_request r ON r.id=o.request_id WHERE r.user_id=${userId} ORDER BY o.request_id`,
    contactJobs: await db.sql`SELECT * FROM billing_contact_job WHERE user_id=${userId}`,
    orderJobs:
      await db.sql`SELECT * FROM billing_order_job WHERE user_id=${userId} ORDER BY order_id`,
  };
}
const encode = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));

try {
  const id = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const settledId = crypto.randomUUID();
  const runningId = crypto.randomUUID();
  const deletedUserId = crypto.randomUUID();
  const unknownId = crypto.randomUUID();
  const budgetScope = "restore-budget";
  const budgetDay = new Date().toISOString().slice(0, 10);
  const policyRevision = 7;
  const productId = fixture.config.POLAR_MONTHLY_PRODUCT_ID;
  if (!productId) throw new Error("Restore fixture product is missing");
  const policy = testPolicy({ revision: policyRevision, enabled: false });
  const reversedProductId = policy.topups[0]?.productId;
  if (!reversedProductId) throw new Error("Restore fixture top-up product is missing");
  const policyJson = JSON.stringify(policy);
  const policyDigest = createHash("sha256").update(policyJson).digest("hex");
  const price = JSON.stringify({ input: "125000", output: "250000" });
  const usage = JSON.stringify({ input: 1000, output: 100 });

  await fixture.db
    .sql`INSERT INTO auth_user(id,name,email,email_verified) VALUES (${id},'Restore fixture','restore@example.test',true)`;
  const avatar = await processAvatar(
    await sharp({ create: { width: 16, height: 16, channels: 3, background: "#7656ab" } })
      .png()
      .toBuffer(),
  );
  await fixture.db
    .sql`INSERT INTO account_avatar(user_id,version,content,sha256) VALUES (${id},${crypto.randomUUID()},${avatar},${createHash("sha256").update(avatar).digest("hex")})`;
  await fixture.db
    .sql`UPDATE billing_customer SET provider_touched=true,status='active',paid_until=now()+interval '1 day',reconciled_at=now(),subscription_id='restore-subscription',product_id=${productId},period_start=now(),subscription_start=now() WHERE user_id=${id}`;
  await fixture.db
    .sql`INSERT INTO cloud_policy(revision,digest,configuration) VALUES (${policyRevision},${policyDigest},${policyJson}::jsonb)`;
  await fixture.db
    .sql`INSERT INTO cloud_active_policy(singleton,revision) VALUES (true,${policyRevision})`;
  await fixture.db
    .sql`INSERT INTO credit_wallet(user_id,daily_limit_units,welcomed_at) VALUES (${id},1500000,now())`;
  await fixture.db
    .sql`INSERT INTO credit_grant(id,user_id,grant_key,kind,policy_revision,plan_id,amount,spent,held,period_start,expires_at) VALUES (${grantId},${id},'restore-included','included',${policyRevision},'free',2000000,125000,250000,now(),now()+interval '7 days')`;
  await fixture.db
    .sql`INSERT INTO cloud_request(id,user_id,session_id,client_key,provider,model_id,route,policy_revision,price_snapshot,state,reserved,charged,actual_cost,usage,finished_at,lease_until,hold_until) VALUES (${settledId},${id},'restore-session','restore-settled','openai','restore-model','/v1/responses',${policyRevision},${price}::jsonb,'settled',250000,125000,125000,${usage}::jsonb,now(),now()+interval '5 minutes',now()+interval '1 hour')`;
  await fixture.db
    .sql`INSERT INTO cloud_request(id,user_id,session_id,client_key,provider,model_id,route,policy_revision,price_snapshot,state,reserved,lease_until,hold_until) VALUES (${runningId},${id},'restore-session','restore-running','openai','restore-model','/v1/responses',${policyRevision},${price}::jsonb,'running',250000,now()+interval '5 minutes',now()+interval '1 hour')`;
  await fixture.db
    .sql`INSERT INTO credit_allocation(request_id,grant_id,amount) VALUES (${runningId},${grantId},250000)`;
  await fixture.db
    .sql`INSERT INTO provider_bucket(provider,requests,tokens,updated_at) VALUES ('openai',2.5,4000.25,now())`;
  await fixture.db
    .sql`INSERT INTO cloud_outbox(request_id,payload,attempts) VALUES (${settledId},${JSON.stringify({ externalId: settledId, charged_units: 125000 })}::jsonb,1)`;
  await fixture.db
    .sql`INSERT INTO billing_order_job(order_id,user_id,requested,processed,attempts) VALUES ('restore-order',${id},2,1,1)`;

  await fixture.db
    .sql`INSERT INTO email_eligibility(key,welcome_claimed_at,free_anchor,free_period_end) VALUES ('restore-email',now(),now(),now()+interval '7 days'),('restore-alias',now(),now(),now()+interval '7 days')`;
  await fixture.db
    .sql`INSERT INTO email_eligibility_alias(alias_key,canonical_key) VALUES ('restore-alias','restore-email')`;
  await fixture.db.sql`UPDATE auth_user SET eligibility_key='restore-email' WHERE id=${id}`;
  await fixture.db
    .sql`INSERT INTO action_otp(owner_user_id,purpose,destination_key,otp_hash,expires_at) VALUES (${id},'deletion','restore-destination',${"a".repeat(64)},now()+interval '5 minutes')`;
  await fixture.db
    .sql`INSERT INTO billing_checkout(checkout_id,user_id,product_id,policy_revision,kind,expires_at) VALUES ('restore-checkout',${id},${productId},${policyRevision},'subscription',now()+interval '1 hour')`;
  await fixture.db
    .sql`INSERT INTO billing_order_reversal(order_id,user_id,product_id) VALUES ('restore-refunded-before-paid',${id},${reversedProductId})`;
  await fixture.db
    .sql`INSERT INTO auth_user(id,name,email,email_verified) VALUES (${deletedUserId},'Deleted restore fixture','deleted-restore@example.test',true)`;
  await fixture.db.sql`INSERT INTO credit_wallet(user_id) VALUES (${deletedUserId})`;
  await fixture.db
    .sql`INSERT INTO cloud_request(id,user_id,session_id,client_key,provider,model_id,route,policy_revision,price_snapshot,state,reserved,dispatched_at,lease_until,hold_until)
      VALUES (${unknownId},${deletedUserId},'deleted-restore-session','restore-unknown','openai','restore-model','/v1/responses',${policyRevision},${price}::jsonb,'usage_unknown',350000,now(),now(),now())`;
  await fixture.db
    .sql`INSERT INTO cloud_cost_record(request_id,scope,day,reserved,exposure,free_reserved,free_exposure,terminal) VALUES
      (${settledId},${budgetScope},${budgetDay}::date,250000,125000,125000,62500,true),
      (${runningId},${budgetScope},${budgetDay}::date,250000,250000,0,0,false),
      (${unknownId},${budgetScope},${budgetDay}::date,350000,350000,350000,350000,false)`;
  await fixture.db.sql`INSERT INTO cloud_spend_bucket(key,amount) VALUES
      (${`${budgetScope}:total`},725000),
      (${`${budgetScope}:day:${budgetDay}`},725000),
      (${`${budgetScope}:free:${budgetDay}`},412500)`;
  await fixture.db
    .sql`INSERT INTO billing_contact_job(user_id,requested,processed,attempts) VALUES (${id},2,1,1)`;
  // Customer/request rows disappear; independent deployment exposure must remain in the dump.
  await fixture.db.sql`DELETE FROM auth_user WHERE id=${deletedUserId}`;
  if ((await fixture.db.sql`SELECT id FROM cloud_request WHERE id=${unknownId}`).length)
    throw new Error("Deleted customer's request unexpectedly survived");
  const before = await snapshot(fixture.db, id);
  if (
    encode(before.migrations.map((row) => row.name)) !==
      encode((await readdir("migrations")).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) ||
    before.migrations.some((row) => !/^[a-f0-9]{64}$/.test(String(row.digest))) ||
    before.grants.length !== 1 ||
    String(before.grants[0]?.spent) !== "125000" ||
    String(before.grants[0]?.held) !== "250000" ||
    before.requests.length !== 2 ||
    before.allocations.length !== 1 ||
    before.outbox.length !== 1 ||
    before.orderJobs.length !== 1 ||
    before.contactJobs.length !== 1 ||
    before.reversals.length !== 1 ||
    before.reversals[0]?.order_id !== "restore-refunded-before-paid" ||
    before.spendBuckets.length !== 3 ||
    before.costRecords.length !== 3 ||
    !before.spendBuckets.some(
      (row) => row.key === `${budgetScope}:total` && String(row.amount) === "725000",
    ) ||
    !before.costRecords.some(
      (row) =>
        row.request_id === unknownId && String(row.exposure) === "350000" && row.terminal === false,
    )
  )
    throw new Error("Restore fixture was not fully created");

  const dump = join(fixture.directory, "backup.dump");
  await run([
    join(bin, "pg_dump"),
    "--format=custom",
    "--no-owner",
    "--no-acl",
    "--file",
    dump,
    "--dbname",
    original.href,
  ]);
  await fixture.db.close();
  await fixture.pg.dropDatabase("zephium_test");
  await fixture.pg.createDatabase("zephium_restored");
  original.pathname = "/zephium_restored";
  await run([
    join(bin, "pg_restore"),
    "--no-owner",
    "--no-acl",
    "--exit-on-error",
    "--dbname",
    original.href,
    dump,
  ]);
  original.password = password;
  const restored = createDatabase({ ...fixture.config, DATABASE_URL: original.href });
  try {
    const after = await snapshot(restored, id);
    if (encode(after) !== encode(before))
      throw new Error("Restored account, cloud accounting, or migration records differ");
    await applyTopup(restored, policy, {
      id: "restore-refunded-before-paid",
      userId: id,
      productId: reversedProductId,
      paid: true,
      refunded: false,
      createdAt: new Date(),
      policyRevision,
    });
    if (
      (
        await restored.sql`SELECT id FROM credit_grant WHERE user_id=${id} AND grant_key='polar-order:restore-refunded-before-paid'`
      ).length
    )
      throw new Error("Restored reversal allowed stale paid credit");
    console.log(
      "PostgreSQL dump restored after deleting the source database; account, billing, cloud accounting, and all migration records match.",
    );
  } finally {
    await restored.close();
  }
} finally {
  await fixture.close();
}
