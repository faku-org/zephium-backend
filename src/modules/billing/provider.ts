import { HTTPClient, Polar } from "@polar-sh/sdk";
import { Webhook } from "standardwebhooks";
import { z } from "zod";
import type { Config } from "../../platform/config";
import { AppError } from "../../platform/errors";

export interface CustomerState {
  customerId: string;
  accountId: string;
  subscriptions: {
    id?: string;
    periodStart?: Date;
    subscriptionStart?: Date;
    productId: string;
    status: string;
    paidUntil: Date;
    cancelAtPeriodEnd: boolean;
  }[];
}
export type Purchase = { kind: "subscription"; interval: "monthly" | "yearly" } | { kind: "topup" };
export interface BillingOrder {
  id: string;
  checkoutId?: string;
  userId: string;
  productId: string;
  paid: boolean;
  refunded: boolean;
  createdAt: Date;
  policyRevision?: number;
  refundRequiresReview?: boolean;
}
export interface ProductOffer {
  productId: string;
  productName: string;
  price: { amount_minor: number; currency: string };
}
export interface BillingProvider {
  state(accountId: string): Promise<CustomerState | null>;
  checkout(
    accountId: string,
    email: string,
    productId: string,
    policyRevision?: number,
    purchase?: Purchase,
  ): Promise<{ id?: string; url: string; expiresAt: Date }>;
  productOffer?(productId: string, purchase: Purchase): Promise<ProductOffer>;
  ordersForCheckouts?(accountId: string, checkoutIds: string[]): Promise<BillingOrder[]>;
  portal(accountId: string): Promise<string>;
  deleteCustomer(accountId: string): Promise<void>;
  openCheckoutUntil(accountId: string): Promise<Date | null>;
  order?(orderId: string): Promise<BillingOrder>;
  ingestUsage?(payload: Record<string, unknown>): Promise<void>;
}
const missing = (error: unknown) =>
  error instanceof Error && "statusCode" in error && error.statusCode === 404;
export function polarProvider(
  config: Pick<Config, "POLAR_ACCESS_TOKEN" | "POLAR_ENVIRONMENT" | "BILLING_RETURN_URL"> & {
    BILLING_SUCCESS_URL?: string;
  },
): BillingProvider {
  const polar = new Polar({
    httpClient: new HTTPClient({ fetcher: boundedBillingFetch }),
    accessToken: config.POLAR_ACCESS_TOKEN,
    server: config.POLAR_ENVIRONMENT,
    timeoutMs: 8000,
    retryConfig: { strategy: "none" },
  });
  function enabled() {
    if (!config.POLAR_ACCESS_TOKEN) throw new AppError("billing_unavailable", 503);
  }
  type Product = Awaited<ReturnType<typeof polar.products.get>>;
  const products = new Map<string, { value: Product; until: number }>();
  const loading = new Map<string, Promise<Product>>();
  async function product(id: string): Promise<Product> {
    enabled();
    const cached = products.get(id);
    if (cached && cached.until > Date.now()) return cached.value;
    const pending = loading.get(id);
    if (pending) return pending;
    const request = polar.products
      .get({ id }, { signal: AbortSignal.timeout(8000) })
      .then((value) => {
        if (value.id !== id) throw new AppError("provider_identity_mismatch", 503);
        if (products.size >= 64) products.delete(products.keys().next().value ?? "");
        products.set(id, { value, until: Date.now() + 60_000 });
        return value;
      })
      .finally(() => loading.delete(id));
    loading.set(id, request);
    return request;
  }
  function orderValue(o: Awaited<ReturnType<typeof polar.orders.get>>): BillingOrder {
    if (!o.customer.externalId || !o.productId)
      throw new AppError("provider_order_identity_invalid", 502);
    const revision = o.metadata.zephium_policy_revision;
    return {
      id: o.id,
      checkoutId: o.checkoutId ?? undefined,
      userId: o.customer.externalId,
      productId: o.productId,
      paid: o.paid,
      refunded:
        o.refundedAmount > 0 || o.status === "refunded" || o.status === "partially_refunded",
      refundRequiresReview: o.status === "partially_refunded",
      createdAt: o.createdAt,
      policyRevision: typeof revision === "number" ? revision : undefined,
    };
  }
  return {
    async state(accountId) {
      enabled();
      try {
        const c = await polar.customers.getStateExternal({ externalId: accountId });
        if (c.externalId !== accountId) throw new AppError("provider_identity_mismatch", 503);
        return {
          customerId: c.id,
          accountId,
          subscriptions: c.activeSubscriptions.map((s) => ({
            id: s.id,
            periodStart: s.currentPeriodStart,
            subscriptionStart: s.startedAt ?? s.currentPeriodStart,
            productId: s.productId,
            status: s.status,
            paidUntil: s.currentPeriodEnd,
            cancelAtPeriodEnd: s.cancelAtPeriodEnd,
          })),
        };
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async checkout(accountId, email, productId, policyRevision, purchase) {
      enabled();
      if (!purchase) throw new AppError("purchase_type_required", 503);
      const signal = AbortSignal.timeout(8000);
      // Cached prices are for display only. Re-read the actual product before purchase.
      const selected = await polar.products.get({ id: productId }, { signal });
      if (selected.id !== productId) throw new AppError("provider_identity_mismatch", 503);
      assertPurchaseProduct(selected, purchase);
      const c = await polar.checkouts.create(
        {
          products: [productId],
          externalCustomerId: accountId,
          ...(policyRevision ? { metadata: { zephium_policy_revision: policyRevision } } : {}),
          customerEmail: email,
          allowTrial: false,
          allowDiscountCodes: false,
          successUrl: config.BILLING_SUCCESS_URL ?? config.BILLING_RETURN_URL,
          returnUrl: config.BILLING_RETURN_URL,
        },
        { signal },
      );
      return {
        id: c.id,
        url: approvedPortalURL(c.url, config.POLAR_ENVIRONMENT),
        expiresAt: c.expiresAt,
      };
    },
    async productOffer(productId, purchase) {
      const value = await product(productId);
      assertPurchaseProduct(value, purchase);
      const active = value.prices.filter((price) => !price.isArchived);
      const price = active[0];
      if (
        price?.amountType !== "fixed" ||
        !/^[a-z]{3}$/i.test(price.priceCurrency) ||
        !value.name.trim()
      )
        throw new AppError("product_configuration_invalid", 503);
      return {
        productId,
        productName: value.name,
        price: { amount_minor: price.priceAmount, currency: price.priceCurrency.toUpperCase() },
      };
    },
    async ordersForCheckouts(accountId, checkoutIds) {
      enabled();
      if (!checkoutIds.length) return [];
      if (checkoutIds.length > 20) throw new AppError("provider_result_limit", 503);
      const pages = await polar.orders.list(
        { externalCustomerId: accountId, checkoutId: checkoutIds, limit: 100 },
        { signal: AbortSignal.timeout(8000) },
      );
      const orders: BillingOrder[] = [];
      let pageCount = 0;
      for await (const page of pages) {
        if (++pageCount > 2) throw new AppError("provider_result_limit", 503);
        for (const item of page.result.items) {
          const order = orderValue(item);
          if (
            order.userId !== accountId ||
            !order.checkoutId ||
            !checkoutIds.includes(order.checkoutId)
          )
            throw new AppError("provider_order_identity_invalid", 502);
          orders.push(order);
          if (orders.length > 200) throw new AppError("provider_result_limit", 503);
        }
      }
      return orders;
    },
    async portal(accountId) {
      enabled();
      try {
        return approvedPortalURL(
          (
            await polar.customerSessions.create({
              externalCustomerId: accountId,
              returnUrl: config.BILLING_RETURN_URL,
            })
          ).customerPortalUrl,
          config.POLAR_ENVIRONMENT,
        );
      } catch (error) {
        if (missing(error)) throw new AppError("no_billing_account", 409);
        throw error;
      }
    },
    async deleteCustomer(accountId) {
      enabled();
      try {
        await polar.customers.deleteExternal({ externalId: accountId, anonymize: true });
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },
    async openCheckoutUntil(accountId) {
      enabled();
      const pages = await polar.checkouts.list(
        {
          externalCustomerId: accountId,
          status: ["open", "confirmed"],
          limit: 100,
        },
        { signal: AbortSignal.timeout(8000) },
      );
      let latest: Date | null = null;
      let count = 0;
      for await (const page of pages) {
        if (++count > 10) throw new AppError("provider_result_limit", 503);
        for (const checkout of page.result.items) {
          const until =
            checkout.status === "confirmed"
              ? new Date(Math.max(checkout.expiresAt.getTime(), Date.now() + 900_000))
              : checkout.expiresAt;
          if (!latest || until > latest) latest = until;
        }
      }
      return latest;
    },
    async order(id) {
      enabled();
      return orderValue(await polar.orders.get({ id }));
    },
    async ingestUsage(payload) {
      enabled();
      const event = z
        .object({
          externalId: z.string(),
          name: z.literal("zephium_ai_usage"),
          externalCustomerId: z.string(),
          timestamp: z.string(),
          metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
        })
        .parse(payload);
      const result = await polar.events.ingest({
        events: [{ ...event, timestamp: new Date(event.timestamp) }],
      });
      if (result.inserted + result.duplicates !== 1)
        throw new AppError("usage_export_not_acknowledged", 502);
    },
  };
}

export function assertPurchaseProduct(
  product: {
    isArchived: boolean;
    isRecurring: boolean;
    recurringInterval: string | null;
    recurringIntervalCount: number | null;
    prices: readonly { isArchived: boolean; amountType: string; priceAmount?: number | null }[];
  },
  purchase: { kind: "subscription"; interval: "monthly" | "yearly" } | { kind: "topup" },
) {
  const prices = product.prices.filter((p) => !p.isArchived);
  if (
    product.isArchived ||
    prices.length !== 1 ||
    prices.some(
      (p) =>
        p.amountType !== "fixed" ||
        typeof p.priceAmount !== "number" ||
        !Number.isSafeInteger(p.priceAmount) ||
        p.priceAmount <= 0,
    )
  )
    throw new AppError("product_configuration_invalid", 503);
  if (
    purchase.kind === "topup"
      ? product.isRecurring
      : !product.isRecurring ||
        product.recurringInterval !== (purchase.interval === "monthly" ? "month" : "year") ||
        product.recurringIntervalCount !== 1
  )
    throw new AppError("product_configuration_invalid", 503);
}

function approvedPortalURL(value: string, environment: "sandbox" | "production") {
  const url = new URL(value);
  const origin = environment === "sandbox" ? "https://sandbox.polar.sh" : "https://polar.sh";
  if (url.origin !== origin || url.username || url.password)
    throw new AppError("provider_destination_invalid", 503);
  return url.href;
}

/** Enforce a total request deadline, no redirects, and a decoded response-size budget around the SDK. */
export async function boundedBillingFetch(input: RequestInfo | URL, init?: RequestInit) {
  const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const signal = AbortSignal.any([AbortSignal.timeout(8000), ...(inherited ? [inherited] : [])]);
  const response = await fetch(input, { ...init, redirect: "error", signal });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new AppError("provider_response_limit", 503);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks), {
    status: response.status,
    headers,
  });
}
export function verifyBillingEvent(
  body: string,
  headers: Headers,
  secret: string,
  format: "standard" | "legacy",
) {
  // Polar's new keys follow Standard Webhooks; legacy keys use their literal UTF-8 bytes.
  const key = format === "legacy" ? Buffer.from(secret).toString("base64") : secret;
  let raw: unknown;
  try {
    raw = new Webhook(key).verify(body, Object.fromEntries(headers.entries()));
  } catch {
    throw new AppError("invalid_signature", 403);
  }
  const event = z
    .object({
      type: z.string().max(100),
      data: z
        .object({
          id: z.string().max(100).optional(),
          external_id: z.string().max(100).nullish(),
          customer: z
            .object({ external_id: z.string().max(100).nullish() })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    })
    .safeParse(raw);
  if (!event.success) throw new AppError("invalid_event");
  const id = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/)
    .parse(headers.get("webhook-id"));
  return {
    id,
    accountId: event.data.data.external_id ?? event.data.data.customer?.external_id ?? null,
    orderId: event.data.type.startsWith("order.") ? (event.data.data.id ?? null) : null,
  };
}
