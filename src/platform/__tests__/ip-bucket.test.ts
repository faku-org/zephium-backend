import { expect, test } from "bun:test";
import { canonicalIp, emailNetwork } from "../ip-bucket";

test("equivalent IPv6 and IPv4-mapped spellings share buckets", () => {
  expect(canonicalIp("2001:db8::1")).toBe(canonicalIp("2001:0DB8:0000:0:0:0000:0:1"));
  expect(canonicalIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
  expect(canonicalIp("0:0:0:0:0:ffff:c000:0201")).toBe("192.0.2.1");
  expect(canonicalIp("::")).toBe("0000:0000:0000:0000:0000:0000:0000:0000");
  expect(canonicalIp("2001:db8::192.0.2.1")).toBe("2001:0db8:0000:0000:0000:0000:c000:0201");
});
test("email send velocity groups privacy addresses, without grouping IPv4 neighbours", () => {
  expect(emailNetwork("2001:db8:abcd:1::1")).toBe(
    emailNetwork("2001:db8:abcd:1:ffff:ffff:ffff:ffff"),
  );
  expect(emailNetwork("2001:db8:abcd:1::1")).not.toBe(emailNetwork("2001:db8:abcd:2::1"));
  expect(emailNetwork("192.0.2.1")).not.toBe(emailNetwork("192.0.2.2"));
  expect(emailNetwork("::ffff:192.0.2.1")).toBe(emailNetwork("192.0.2.1"));
});
test("invalid client addresses fail closed", () => {
  for (const value of ["", "host", "1.2.3", "192.0.2.999", "fe80::1%en0", "2001:::1"]) {
    expect(() => canonicalIp(value)).toThrow("unavailable");
  }
});
