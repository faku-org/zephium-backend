import { BlockList, isIP } from "node:net";

function trustedAddresses(cidrs: string): (address: string) => boolean {
  const list = new BlockList();
  for (const entry of cidrs
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const parts = entry.split("/");
    const address = parts[0] ?? "";
    const family = isIP(address);
    const maximum = family === 6 ? 128 : 32;
    const mask = parts[1] === undefined ? maximum : Number(parts[1]);
    if (
      !family ||
      parts.length > 2 ||
      (parts[1] !== undefined && !/^\d+$/.test(parts[1])) ||
      !Number.isInteger(mask) ||
      mask < 0 ||
      mask > maximum
    )
      throw new Error("Invalid trusted proxy CIDR");
    list.addSubnet(address, mask, family === 6 ? "ipv6" : "ipv4");
  }
  return (address) => {
    const family = isIP(address);
    return family !== 0 && list.check(address, family === 6 ? "ipv6" : "ipv4");
  };
}

/** Compile trust lists once at startup. Never use forwarding headers from a direct client. */
export function createClientAddressResolver(proxyCidrs: string, cloudflareCidrs = "") {
  const trustedProxy = trustedAddresses(proxyCidrs);
  const trustedCloudflare = trustedAddresses(cloudflareCidrs);
  return (peer: string, headers: Headers): string => {
    if (!trustedProxy(peer)) return peer;
    const chain = headers.get("x-forwarded-for");
    // Bound parsing even when a caller supplies an oversized forwarding chain.
    if (!chain || chain.length > 4096) return peer;
    const nearest = chain.slice(chain.lastIndexOf(",") + 1).trim();
    if (!isIP(nearest)) return peer;
    // Traefik MUST append its actual connection peer. Only a verified Cloudflare
    // hop may supply CF-Connecting-IP; an arbitrary client cannot opt into it.
    if (trustedCloudflare(nearest)) {
      const original = headers.get("cf-connecting-ip")?.trim();
      if (original && isIP(original)) return original;
    }
    return nearest;
  };
}

export function clientAddress(peer: string, headers: Headers, proxyCidrs: string) {
  return createClientAddressResolver(proxyCidrs)(peer, headers);
}
