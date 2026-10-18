import { loadPolicy, registerPolicy } from "../src/modules/policy/policy";
import { readWorkerConfig } from "../src/platform/config";
import { createDatabase } from "../src/platform/db";

const [command, path = "config/cloud.json"] = process.argv.slice(2);
if (!["validate", "register"].includes(command ?? ""))
  throw new Error("Usage: cloud-policy.ts validate|register [CONFIG]");
const policy = await loadPolicy(path);
if (command === "register") {
  const db = createDatabase(readWorkerConfig());
  try {
    await registerPolicy(db, policy);
  } finally {
    await db.close();
  }
}
console.log(
  JSON.stringify({
    revision: policy.revision,
    enabled: policy.enabled,
    plans: policy.plans.map((p) => p.id),
    enabledModels: policy.models.filter((m) => m.enabled).map((m) => m.id),
  }),
);
