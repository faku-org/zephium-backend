import { readAdminConfig } from "../src/apps/admin/config";
import { createAdminDatabase } from "../src/modules/admin/database";
import {
  disableAdminOperator,
  provisionAdminOperator,
  resetAdminOperatorPassword,
  revokeAdminOperator,
} from "../src/modules/admin/operators";

/** Password is supplied over stdin; arguments, logs and output never contain credentials. */
async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("password_stdin_required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 512) throw new Error("invalid_input");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}
async function main() {
  const args = process.argv.slice(2);
  const explicit = ["create", "disable", "revoke", "reset-password"].includes(args[0] ?? "");
  const action = explicit ? args.shift() : "create";
  const [email, name] = args;
  if (!email || (action === "create" ? args.length !== 2 || !name : args.length !== 1)) {
    console.error(
      "Usage: bun scripts/admin-operator.ts [create] EMAIL NAME | disable EMAIL | revoke EMAIL | reset-password EMAIL; create/reset-password require password on stdin",
    );
    process.exitCode = 1;
    return;
  }
  const password =
    action === "create" || action === "reset-password" ? await readPassword() : undefined;
  const db = createAdminDatabase(readAdminConfig());
  try {
    if (action === "disable") {
      await disableAdminOperator(db, email);
      console.log("Operator disabled and current sessions and challenges revoked.");
    } else if (action === "revoke") {
      await revokeAdminOperator(db, email);
      console.log("Current operator sessions and challenges revoked.");
    } else if (action === "reset-password") {
      await resetAdminOperatorPassword(db, email, password ?? "");
      console.log(
        "Operator password reset and current sessions and challenges revoked; MFA and account status preserved.",
      );
    } else {
      await provisionAdminOperator(db, email, name ?? "", password ?? "");
      console.log(
        "Operator created. Sign in and enroll an authenticator before accessing reports.",
      );
    }
  } finally {
    await db.close();
  }
}
if (import.meta.main) {
  main().catch(() => {
    // Database errors may contain password hashes or operator email. Never print them.
    console.error("Operator command failed. Check the input and admin database configuration.");
    process.exitCode = 1;
  });
}
