import { expect, test } from "bun:test";
import {
  boundaryViolation,
  checkArchitecture,
  sourceImports,
} from "../../scripts/check-architecture";

test("production source respects declared module interfaces", async () => {
  expect(await checkArchitecture()).toEqual([]);
});
test("guard rejects private, reversed and application dependencies including types", () => {
  expect(boundaryViolation("src/modules/ai/service.ts", "src/modules/credits/ledger")).toContain(
    "index.ts",
  );
  expect(boundaryViolation("src/modules/identity/account.ts", "src/modules/billing")).toContain(
    "undeclared",
  );
  expect(boundaryViolation("src/platform/config.ts", "src/modules/policy")).toContain("platform");
  expect(boundaryViolation("src/modules/credits/ledger.ts", "src/apps/api/app")).toContain(
    "application",
  );
  expect(boundaryViolation("src/modules/identity/auth.ts", "src/platform/db/schema")).toContain(
    "own schema",
  );
  expect(
    boundaryViolation("src/modules/billing/service.ts", "src/modules/credits/index"),
  ).toBeNull();
  expect(
    boundaryViolation("src/modules/billing/schema.ts", "src/modules/identity/schema"),
  ).toBeNull();
  expect(boundaryViolation("src/platform/db/schema.ts", "src/modules/identity/schema")).toBeNull();
  expect(
    sourceImports(
      'import type { A } from "../identity/private";\nimport { type B } from "../credits/internal";\nexport type { C } from "../policy/hidden";',
    ),
  ).toEqual(["../identity/private", "../credits/internal", "../policy/hidden"]);
});
