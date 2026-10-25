import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { symmetricDecrypt } from "better-auth/crypto";
import type postgres from "postgres";
import { type AdminAuth, type AdminAuthDatabase, createAdminAuth } from "../src/modules/admin/auth";
import { getAdminSession, handleAdminAuth } from "../src/modules/admin/authorization";
import {
  assertAdminDatabasePrivileges,
  createAdminDatabase,
  createReportDatabase,
} from "../src/modules/admin/database";
import { provisionAdminOperator } from "../src/modules/admin/operators";
import { createAdminReports } from "../src/modules/admin/reports";
import { createDatabase } from "../src/platform/db";
import { testDatabase } from "../tests/support/admin-database";

const origin = "https://admin-restore.example.test";
let phase = "local fixture creation";
class LocalBrowser {
  private cookies = new Map<string, string>();
  constructor(
    private auth: AdminAuth,
    private db: AdminAuthDatabase,
  ) {}
  headers() {
    return new Headers({
      cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    });
  }
  async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const headers = this.headers();
    headers.set("origin", origin);
    headers.set("content-type", "application/json");
    const response = await handleAdminAuth(
      new Request(`${origin}/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
      this.auth,
      this.db,
    );
    if (!response.ok) throw new Error("local_authentication_failed");
    for (const entry of response.headers.getSetCookie()) {
      const pair = entry.split(";")[0] ?? "";
      const separator = pair.indexOf("=");
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const result = (await response.json()) as Record<string, unknown>;
    if ("token" in result || "user" in result) throw new Error("unsafe_auth_projection");
    return result;
  }
}

async function snapshot(sql: postgres.Sql) {
  return {
    user: await sql`SELECT * FROM admin_auth_user ORDER BY id`,
    account: await sql`SELECT * FROM admin_auth_account ORDER BY id`,
    factor: await sql`SELECT * FROM admin_auth_two_factor ORDER BY id`,
    session: await sql`SELECT * FROM admin_auth_session ORDER BY id`,
    verification: await sql`SELECT * FROM admin_auth_verification ORDER BY id`,
    throttle: await sql`SELECT * FROM admin_auth_throttle ORDER BY key`,
    audit: await sql`SELECT * FROM admin_audit_event ORDER BY id`,
    migrations: await sql`SELECT name,digest FROM admin_schema_migration ORDER BY name`,
    // Compare effective ACLs: pg_restore may represent owner-only defaults as NULL.
    // Cluster roles are a separate recovery prerequisite.
    metadata:
      await sql`SELECT c.relname,ARRAY(SELECT entry::text FROM unnest(coalesce(c.relacl,acldefault('r',c.relowner))) entry ORDER BY entry::text) AS acl,pg_get_userbyid(c.relowner) AS owner,
      CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid,true) ELSE NULL END AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'admin_%' AND c.relkind IN ('r','v') ORDER BY c.relname`,
    users: await sql`SELECT * FROM admin_report_users ORDER BY id`,
  };
}

async function main() {
  const bin = process.env.PG_TOOLS ?? resolve(".local/postgres-tools/bin");
  const fixture = await testDatabase();
  let sourceAuth: ReturnType<typeof createAdminDatabase> | undefined;
  let sourceReports: ReturnType<typeof createReportDatabase> | undefined;
  let restoredOwner: ReturnType<typeof createDatabase> | undefined;
  let restoredAuth: ReturnType<typeof createAdminDatabase> | undefined;
  let restoredReports: ReturnType<typeof createReportDatabase> | undefined;
  const ownerUrl = new URL(fixture.config.DATABASE_URL);
  const ownerPassword = decodeURIComponent(ownerUrl.password);
  ownerUrl.password = "";
  const rolePasswords = new Map<string, string>();
  const roleUrl = (role: string, database: string) => {
    const value = new URL(fixture.config.DATABASE_URL);
    value.username = role;
    value.password = rolePasswords.get(role) ?? "";
    value.pathname = `/${database}`;
    return value.href;
  };
  const run = async (command: string[]) => {
    const child = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PGPASSWORD: ownerPassword },
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    try {
      const [code] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error("local_backup_command_failed");
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    phase = "local role setup";
    await fixture.db.sql.unsafe(
      await Bun.file(new URL("../deploy/postgres/admin-roles.sql", import.meta.url)).text(),
    );
    for (const role of ["zephium_admin_auth", "zephium_admin_report"]) {
      // Only fixed role identifiers and generated hex passwords reach this local-only DDL.
      const password = crypto.randomUUID().replaceAll("-", "");
      rolePasswords.set(role, password);
      await fixture.db.sql.unsafe(`ALTER ROLE ${role} PASSWORD '${password}'`);
    }
    phase = "restricted role verification";
    sourceAuth = createAdminDatabase({
      ADMIN_AUTH_DATABASE_URL: roleUrl("zephium_admin_auth", "zephium_test"),
    });
    sourceReports = createReportDatabase(roleUrl("zephium_admin_report", "zephium_test"));
    await assertAdminDatabasePrivileges(sourceAuth.sql, sourceReports);
    phase = "operator enrollment";
    const config = {
      ADMIN_ORIGIN: origin,
      ADMIN_AUTH_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    };
    const email = "restore.operator@example.test";
    const password = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    await provisionAdminOperator(sourceAuth, email, "Restore operator", password);
    const auth = createAdminAuth(config, sourceAuth);
    const browser = new LocalBrowser(auth, sourceAuth);
    await browser.post("/sign-in/email", { email, password });
    const enrollment = await browser.post("/two-factor/enable", { password });
    if (!Array.isArray(enrollment.backupCodes) || !enrollment.backupCodes.length)
      throw new Error("missing_recovery_codes");
    const [factor] = await sourceAuth.sql`SELECT secret FROM admin_auth_two_factor`;
    if (!factor?.secret) throw new Error("missing_enrollment");
    const totpSecret = await symmetricDecrypt({
      key: config.ADMIN_AUTH_SECRET,
      data: factor.secret,
    });
    await browser.post("/two-factor/verify-totp", {
      code: (await auth.api.generateTOTP({ body: { secret: totpSecret } })).code,
    });
    const session = await getAdminSession(browser.headers(), auth, sourceAuth);
    if (!session?.mfaVerified) throw new Error("missing_session_proof");
    // Preserve an outstanding challenge as well as the verified session in the snapshot.
    await new LocalBrowser(auth, sourceAuth).post("/sign-in/email", { email, password });
    await sourceAuth.sql`INSERT INTO admin_auth_throttle(key,count,expires_at) VALUES (${"a".repeat(64)},1,now()+interval '5 minutes')`;
    await sourceAuth.sql`INSERT INTO admin_audit_event(id,operator_id,action) VALUES (${crypto.randomUUID()},${session.id},'overview')`;
    const customerId = crypto.randomUUID();
    await fixture.db
      .sql`INSERT INTO auth_user(id,name,email,email_verified) VALUES (${customerId},'Restore customer','restore.customer@example.test',true)`;
    phase = "state snapshot";
    const before = await snapshot(fixture.db.sql);
    const dump = join(fixture.directory, "admin-backup.dump");
    phase = "database dump";
    await run([
      join(bin, "pg_dump"),
      "--format=custom",
      "--no-owner",
      "--file",
      dump,
      "--dbname",
      ownerUrl.href,
    ]);
    const bytes = (await stat(dump)).size;
    phase = "fresh restore database creation";
    await sourceAuth.close();
    sourceAuth = undefined;
    await sourceReports.end({ timeout: 5 });
    sourceReports = undefined;
    await fixture.db.close();
    await fixture.pg.dropDatabase("zephium_test");
    await fixture.pg.createDatabase("zephium_admin_restored");
    ownerUrl.pathname = "/zephium_admin_restored";
    phase = "database restore";
    await run([
      join(bin, "pg_restore"),
      "--no-owner",
      "--exit-on-error",
      "--dbname",
      ownerUrl.href,
      dump,
    ]);
    ownerUrl.password = ownerPassword;
    phase = "restored state comparison";
    restoredOwner = createDatabase({ ...fixture.config, DATABASE_URL: ownerUrl.href });
    const after = await snapshot(restoredOwner.sql);
    const differences = (Object.keys(before) as Array<keyof typeof before>).filter(
      (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    );
    if (differences.length) {
      phase = `restored state comparison (${differences.join(", ")})`;
      throw new Error("restored_admin_state_differs");
    }
    phase = "restored role verification";
    restoredAuth = createAdminDatabase({
      ADMIN_AUTH_DATABASE_URL: roleUrl("zephium_admin_auth", "zephium_admin_restored"),
    });
    restoredReports = createReportDatabase(
      roleUrl("zephium_admin_report", "zephium_admin_restored"),
    );
    await assertAdminDatabasePrivileges(restoredAuth.sql, restoredReports);
    phase = "restored operator authentication";
    const restored = createAdminAuth(config, restoredAuth);
    const recovered = new LocalBrowser(restored, restoredAuth);
    const login = await recovered.post("/sign-in/email", { email, password });
    if (
      login.twoFactorRedirect !== true ||
      (await getAdminSession(recovered.headers(), restored, restoredAuth))
    )
      throw new Error("restored_mfa_not_enforced");
    // Use the ORIGINAL enrolled authenticator secret; never re-enroll during restore.
    await recovered.post("/two-factor/verify-totp", {
      code: (await restored.api.generateTOTP({ body: { secret: totpSecret } })).code,
    });
    if (!(await getAdminSession(recovered.headers(), restored, restoredAuth))?.mfaVerified)
      throw new Error("restored_mfa_failed");
    const recovery = new LocalBrowser(restored, restoredAuth);
    await recovery.post("/sign-in/email", { email, password });
    await recovery.post("/two-factor/verify-backup-code", { code: enrollment.backupCodes[0] });
    if (!(await getAdminSession(recovery.headers(), restored, restoredAuth))?.mfaVerified)
      throw new Error("restored_recovery_code_failed");
    phase = "restored report projection";
    const users = await createAdminReports(restoredReports).users("restore.customer@example.test");
    if (users.items.length !== 1 || users.items[0]?.id !== customerId)
      throw new Error("restored_projection_failed");
    console.log(
      `Local optional-admin restore passed (${bytes} dump bytes): source database deleted; auth rows, MFA ciphertext, session proof, challenges, audit, migration digest, view definitions and object ACLs match; restricted-role password/TOTP and recovery-code logins succeeded without reenrollment.`,
    );
  } finally {
    await Promise.all([
      sourceAuth?.close(),
      sourceReports?.end({ timeout: 5 }),
      restoredAuth?.close(),
      restoredReports?.end({ timeout: 5 }),
      restoredOwner?.close(),
    ]);
    await fixture.close();
  }
}
if (import.meta.main) {
  await main().catch(() => {
    // Do not emit database URLs, password hashes, MFA secrets or raw command errors.
    console.error(
      `Local optional-admin restore check failed during ${phase}. Check PostgreSQL tools and local fixture prerequisites.`,
    );
    process.exit(1);
  });
}
