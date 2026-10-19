import { expect, test } from "bun:test";
import { polarProvider } from "../provider";

const accountId = "account-contact-123";
const customerId = "00000000-0000-4000-8000-000000000401";

// Complete synthetic customer exercises the pinned SDK response decoder.
function customer(overrides: Record<string, unknown> = {}) {
  return {
    id: customerId,
    created_at: "2026-10-01T12:00:00.000Z",
    modified_at: null,
    metadata: {},
    external_id: accountId,
    email: "old@example.test",
    email_verified: true,
    type: "individual",
    name: null,
    billing_name: null,
    billing_address: null,
    tax_id: null,
    organization_id: "test-organization",
    deleted_at: null,
    avatar_url: null,
    ...overrides,
  };
}

function adapter(fetcher: Parameters<typeof polarProvider>[1]) {
  const provider = polarProvider(
    {
      POLAR_ACCESS_TOKEN: "synthetic-test-token",
      POLAR_ENVIRONMENT: "sandbox",
      BILLING_RETURN_URL: "https://example.test/billing",
    },
    fetcher,
  );
  if (!provider.updateCustomerEmail) throw new Error("Missing contact adapter");
  return { state: provider.state, update: provider.updateCustomerEmail };
}

test("customer state exposes contact email using the stable external account ID", async () => {
  const requests: Request[] = [];
  const provider = adapter(async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({
      ...customer(),
      active_subscriptions: [],
      granted_benefits: [],
      active_meters: [],
    });
  });
  expect(await provider.state(accountId)).toEqual({
    customerId,
    accountId,
    email: "old@example.test",
    subscriptions: [],
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe("GET");
  expect(new URL(requests[0]?.url ?? "").pathname).toBe(
    `/v1/customers/external/${accountId}/state`,
  );
});

test("contact sync PATCHes only normalized email by external ID and verifies the response", async () => {
  const requests: Request[] = [];
  const provider = adapter(async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json(customer({ email: "NEW@example.test" }));
  });
  await provider.update(accountId, " New@example.test ");
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (!request) throw new Error("Missing request");
  expect(request.method).toBe("PATCH");
  expect(new URL(request.url).pathname).toBe(`/v1/customers/external/${accountId}`);
  expect(new URL(request.url).search).toBe("");
  expect(await request.json()).toEqual({ email: "new@example.test" });
});

test("contact sync rejects mismatched external ownership or returned email", async () => {
  for (const overrides of [
    { external_id: "other-account", email: "new@example.test" },
    { email: "other@example.test" },
  ]) {
    let calls = 0;
    const provider = adapter(async () => {
      calls++;
      return Response.json(customer(overrides));
    });
    await expect(provider.update(accountId, "new@example.test")).rejects.toMatchObject({
      code: "provider_identity_mismatch",
    });
    expect(calls).toBe(1);
  }
});

test("a missing Polar customer never falls back to creating a contact", async () => {
  const methods: string[] = [];
  const provider = adapter(async (input, init) => {
    methods.push(new Request(input, init).method);
    return Response.json(
      { error: "ResourceNotFound", detail: "Synthetic missing customer" },
      {
        status: 404,
      },
    );
  });
  await expect(provider.update(accountId, "new@example.test")).rejects.toThrow();
  expect(methods).toEqual(["PATCH"]);
});
