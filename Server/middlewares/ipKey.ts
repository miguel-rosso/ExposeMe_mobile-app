import { isIPv6 } from "net";

// Shared by every per-IP limit (Express middlewares and socket.io handshakes), so they all count the same key.

/** Full 8-group form of an IPv6 address (no zone id), or null if it isn't one. */
function expandIPv6(ip: string): string[] | null {
  if (!isIPv6(ip)) return null;
  let addr = ip;
  // Trailing embedded IPv4 (e.g. ::1.2.3.4) → two hex groups
  const v4 = addr.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    addr = addr.slice(0, -v4[0].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return groups.map((g) => parseInt(g, 16).toString(16));
}

/** /96 prefixes (first 6 groups, as expandIPv6 returns them) whose low 32 bits are a whole IPv4 address. */
const IPV4_MAPPED_PREFIX = "0:0:0:0:0:ffff"; // ::ffff:a.b.c.d
const NAT64_WELL_KNOWN_PREFIX = "64:ff9b:0:0:0:0"; // 64:ff9b::a.b.c.d (RFC 6052)
const IPV4_COMPATIBLE_PREFIX = "0:0:0:0:0:0"; // ::a.b.c.d (deprecated), except :: and ::1

/** The IPv4 address embedded in an expanded IPv6 address, as dotted IPv4, or null if it embeds none. */
function embeddedIPv4(groups: string[]): string | null {
  const [hi, lo] = [parseInt(groups[6], 16), parseInt(groups[7], 16)];
  const prefix = groups.slice(0, 6).join(":");
  // In ::/96 a first octet of 0 (0.0.0.0/8, "this network") is never a host: that's ::, ::1 and the like
  const embeds =
    prefix === IPV4_MAPPED_PREFIX || prefix === NAT64_WELL_KNOWN_PREFIX || (prefix === IPV4_COMPATIBLE_PREFIX && hi >> 8 !== 0);
  return embeds ? [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".") : null;
}

/**
 * Key that per-IP limits count by: IPv6 that embeds an IPv4 address (IPv4-mapped ::ffff:a.b.c.d, NAT64
 * 64:ff9b::a.b.c.d, IPv4-compatible ::a.b.c.d; any notation) as that plain IPv4, and any other IPv6 by its /64 prefix
 * (one subscriber usually gets a whole /64, so per-address limits would be trivial to rotate around).
 */
export function ipKey(ip: string): string {
  let addr = ip.trim();
  const bracketed = addr.match(/^\[([^\]]+)\](?::\d+)?$/); // [v6]:port
  if (bracketed) addr = bracketed[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(addr)) addr = addr.slice(0, addr.lastIndexOf(":")); // v4:port
  addr = addr.split("%")[0];
  const groups = expandIPv6(addr);
  if (!groups) return addr;
  return embeddedIPv4(groups) ?? `${groups.slice(0, 4).join(":")}::/64`;
}
