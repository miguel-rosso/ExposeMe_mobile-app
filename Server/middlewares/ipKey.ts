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

/**
 * Key that per-IP limits count by: IPv4-mapped IPv6 (::ffff:a.b.c.d) as plain IPv4, and IPv6 by its /64 prefix
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
  // IPv4-mapped (::ffff:a.b.c.d, in any notation) → dotted IPv4
  if (groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff") {
    const [hi, lo] = [parseInt(groups[6], 16), parseInt(groups[7], 16)];
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}
