import { expect, test } from "bun:test";
import { createClientAddressResolver } from "../client-address";

const proxy = "10.0.6.2";
const edge = "173.245.48.5";
const client = "203.0.113.8";
const resolve = createClientAddressResolver(`${proxy}/32`, "173.245.48.0/20,2400:cb00::/32");
function headers(chain: string, original = client) {
  return new Headers({ "x-forwarded-for": chain, "cf-connecting-ip": original });
}

test("direct callers cannot forge either forwarding header", () => {
  expect(resolve(client, headers(edge, "198.51.100.1"))).toBe(client);
});
test("only the proxy-appended rightmost hop may authorize Cloudflare headers", () => {
  expect(resolve(proxy, headers(`${edge}, ${client}`, "198.51.100.1"))).toBe(client);
  expect(resolve(proxy, headers(`forged, ${edge}`))).toBe(client);
});
test("Cloudflare handling requires explicit opt-in", () => {
  expect(createClientAddressResolver(`${proxy}/32`)(proxy, headers(edge))).toBe(edge);
});
test("separate visitors behind Cloudflare retain separate abuse identities", () => {
  expect(resolve(proxy, headers(edge))).toBe(client);
  expect(resolve(proxy, headers(edge, "198.51.100.1"))).toBe("198.51.100.1");
});
test("IPv6 edges and clients are supported", () => {
  expect(resolve(proxy, headers("2400:cb00::1234", "2001:db8::1234"))).toBe("2001:db8::1234");
});
test("missing or invalid Cloudflare identity cannot select an arbitrary bucket", () => {
  expect(resolve(proxy, new Headers({ "x-forwarded-for": edge }))).toBe(edge);
  for (const value of ["", "not-an-ip", `${client}, 198.51.100.1`, `${client}:1234`]) {
    expect(resolve(proxy, headers(edge, value))).toBe(edge);
  }
});
test("malformed or oversized forwarding chains fall back to the connection peer", () => {
  for (const value of ["", "bad", `${edge},`, "x".repeat(4097)]) {
    expect(resolve(proxy, headers(value))).toBe(proxy);
  }
});
test("proxy CIDR errors fail at construction rather than during requests", () => {
  for (const value of ["bad", "10.0.0.1/33", "10.0.0.1/", "10.0.0.1/1/2", "::1/129", "::1/-1"]) {
    expect(() => createClientAddressResolver(value)).toThrow("Invalid trusted proxy CIDR");
    expect(() => createClientAddressResolver(`${proxy}/32`, value)).toThrow(
      "Invalid trusted proxy CIDR",
    );
  }
});
