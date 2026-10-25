import { expect, test } from "bun:test";
import { WorkerAlerts } from "../alerts";

const billingAlert = "Zephium billing work requires operator attention";
const contactAlert = "Zephium billing contact update requires operator attention";
const budgetAlert = "Zephium cloud spending is near a configured safety limit";
const billingRecovery = "Zephium billing work backlog has recovered";

test("categories alert immediately and keep independent hourly cooldowns", async () => {
  let now = 0;
  const delivered: string[] = [];
  const alerts = new WorkerAlerts(
    async (message) => {
      delivered.push(message);
    },
    () => {
      throw new Error("unexpected delivery failure");
    },
    () => now,
  );
  await alerts.scan({ billing: true, contact: false, budget: false });
  now = 60_000;
  await alerts.scan({ billing: true, contact: true, budget: true });
  expect(delivered).toEqual([billingAlert, contactAlert, budgetAlert]);
  now = 3600_000;
  await alerts.scan({ billing: true, contact: true, budget: true });
  expect(delivered).toEqual([billingAlert, contactAlert, budgetAlert, billingAlert]);
  now += 60_000;
  await alerts.scan({ billing: true, contact: true, budget: true });
  expect(delivered).toEqual([
    billingAlert,
    contactAlert,
    budgetAlert,
    billingAlert,
    contactAlert,
    budgetAlert,
  ]);
});

test("recovery sends once after notification and a new failure bypasses the cooldown", async () => {
  const delivered: string[] = [];
  const alerts = new WorkerAlerts(
    async (message) => {
      delivered.push(message);
    },
    () => {},
    () => 10,
  );
  await alerts.scan({ billing: false, contact: false, budget: false });
  expect(delivered).toEqual([]);
  await alerts.scan({ billing: true });
  await alerts.scan({}); // An unknown or failed check is not a recovery.
  expect(delivered).toEqual([billingAlert]);
  await alerts.scan({ billing: false });
  await alerts.scan({ billing: false });
  await alerts.scan({ billing: true });
  expect(delivered).toEqual([billingAlert, billingRecovery, billingAlert]);
});

test("failed category delivery is retried next scan and other categories still deliver", async () => {
  let failBilling = true;
  let failures = 0;
  const attempts: string[] = [];
  const alerts = new WorkerAlerts(
    async (message) => {
      attempts.push(message);
      if (message === billingAlert && failBilling) throw new Error("failed");
    },
    () => {
      failures++;
    },
    () => 0,
  );
  await alerts.scan({ billing: true, contact: true, budget: true });
  expect(attempts).toEqual([billingAlert, contactAlert, budgetAlert]);
  expect(failures).toBe(1);
  failBilling = false;
  await alerts.scan({ billing: true, contact: true, budget: true });
  expect(attempts).toEqual([billingAlert, contactAlert, budgetAlert, billingAlert]);
});

test("failed recovery retries next scan, and undelivered failures do not send recovery", async () => {
  let failures = 0;
  let failRecovery = true;
  const attempts: string[] = [];
  const alerts = new WorkerAlerts(
    async (message) => {
      attempts.push(message);
      if (message === contactAlert || (message === billingRecovery && failRecovery))
        throw new Error("failed");
    },
    () => {
      failures++;
    },
    () => 0,
  );
  await alerts.scan({ billing: true, contact: true });
  await alerts.scan({ billing: false, contact: false });
  failRecovery = false;
  await alerts.scan({ billing: false, contact: false });
  await alerts.scan({ billing: false, contact: false });
  expect(attempts).toEqual([billingAlert, contactAlert, billingRecovery, billingRecovery]);
  expect(failures).toBe(2);
});

test("a failed reminder stays eligible for the next scan", async () => {
  let now = 0;
  let attempts = 0;
  let failures = 0;
  const alerts = new WorkerAlerts(
    async () => {
      attempts++;
      if (attempts === 2) throw new Error("failed");
    },
    () => {
      failures++;
    },
    () => now,
  );
  await alerts.scan({ budget: true });
  now = 3600_000;
  await alerts.scan({ budget: true });
  now += 60_000;
  await alerts.scan({ budget: true });
  await alerts.scan({ budget: true });
  expect(attempts).toBe(3);
  expect(failures).toBe(1);
});
