import type { IncomingMessage, ServerResponse } from "http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { io as connect } from "socket.io-client";
import {
  createHandshakeLimit,
  createSocketOriginGuard,
  isAllowedHost,
  isAllowedSocketOrigin,
  isHandshakeRequest,
  isJsonpRequest,
  parseAllowedHosts,
  SOCKET_HANDSHAKE_RATE_MAX,
} from "../middlewares/socketOrigin";
import { useTestServer } from "./socketHarness";

// Socket requests (EXP-244): CORS doesn't cover WebSockets or JSONP, so the server itself refuses socket.io
// requests (handshakes and requests of an open session) whose Origin is another website, and JSONP polling.
// No Origin (Node bots, React Native polling) and same-host Origin (React Native's native WebSocket, which derives
// Origin from the socket URL) are accepted.

// ── Origin rule ──
type OriginCase = [origin: string | undefined, host: string | undefined, why: string];

describe("isAllowedSocketOrigin", () => {
  it.each<OriginCase>([
    [undefined, "exposeme.onrender.com", "no Origin (bots, RN polling)"],
    ["https://exposeme.onrender.com", "exposeme.onrender.com", "RN WebSocket over wss, default port"],
    ["http://192.0.2.20:3000", "192.0.2.20:3000", "RN WebSocket on the LAN lab server"],
    ["https://ExposeMe.OnRender.com", "exposeme.onrender.com", "host case differs"],
    ["https://exposeme.onrender.com:443", "exposeme.onrender.com", "explicit default port in Origin"],
    ["https://exposeme.onrender.com", "exposeme.onrender.com:443", "explicit default port in Host"],
  ])("accepts %s for Host %s (%s)", (origin, host) => {
    expect(isAllowedSocketOrigin(origin, host)).toBe(true);
  });

  it.each<OriginCase>([
    ["https://evil.example", "exposeme.onrender.com", "another website"],
    ["https://exposeme.onrender.com.evil.example", "exposeme.onrender.com", "lookalike suffix"],
    ["http://192.0.2.20:8080", "192.0.2.20:3000", "same IP, other port"],
    ["null", "exposeme.onrender.com", "opaque origin (sandboxed iframe, file://)"],
    ["", "exposeme.onrender.com", "empty Origin"],
    ["chrome-extension://abcdef", "abcdef", "non-web protocol"],
    ["https://exposeme.onrender.com", undefined, "no Host header"],
  ])("refuses %s for Host %s (%s)", (origin, host) => {
    expect(isAllowedSocketOrigin(origin, host)).toBe(false);
  });
});

// ── Host allowlist (EXP-251) ──
describe("parseAllowedHosts", () => {
  it("is null (any Host) when ALLOWED_HOSTS is unset, empty or names no valid host", () => {
    expect(parseAllowedHosts(undefined)).toBeNull();
    expect(parseAllowedHosts("")).toBeNull();
    expect(parseAllowedHosts(" , ")).toBeNull();
    expect(parseAllowedHosts("http://[bad")).toBeNull();
  });

  it("keeps lowercase hostnames, ignoring ports, spaces and malformed entries", () => {
    expect(parseAllowedHosts(" ExposeMe.OnRender.com , play.example:8443,[::1]:3000, http://[bad ")).toEqual(
      new Set(["exposeme.onrender.com", "play.example", "[::1]"])
    );
  });
});

describe("isAllowedHost", () => {
  const allowlist = parseAllowedHosts("exposeme.onrender.com,192.0.2.20");

  it("accepts any Host without an allowlist (default: behaviour unchanged)", () => {
    expect(isAllowedHost("evil.example", null)).toBe(true);
    expect(isAllowedHost(undefined, null)).toBe(true);
  });

  it.each([["exposeme.onrender.com"], ["EXPOSEME.onrender.com:443"], ["192.0.2.20:3000"]])("accepts allowlisted Host %s", (host) => {
    expect(isAllowedHost(host, allowlist)).toBe(true);
  });

  it.each([["evil.example"], ["exposeme.onrender.com.evil.example"], ["192.0.2.21:3000"], [""], [undefined]])(
    "refuses Host %s outside the allowlist",
    (host) => {
      expect(isAllowedHost(host, allowlist)).toBe(false);
    }
  );
});

describe("createSocketOriginGuard with ALLOWED_HOSTS", () => {
  const guard = createSocketOriginGuard(parseAllowedHosts("exposeme.onrender.com"));
  /** Error message the guard passes to next(), or "ok". */
  const verdict = (headers: Record<string, string>, url = "/socket.io/?EIO=4&transport=polling") => {
    let result = "pending";
    const req = { url, headers } as unknown as IncomingMessage;
    guard(req, {} as ServerResponse, (err?: Error) => { result = err ? err.message : "ok"; });
    return result;
  };

  it("DNS rebinding: another name for the server's IP with a matching Origin → refused", () => {
    expect(verdict({ host: "rebind.evil.example", origin: "http://rebind.evil.example" })).toBe("Host not allowed");
  });

  it("allowlisted Host: no Origin and same-host Origin → accepted; another Origin → refused", () => {
    expect(verdict({ host: "exposeme.onrender.com" })).toBe("ok");
    expect(verdict({ host: "exposeme.onrender.com", origin: "https://exposeme.onrender.com" })).toBe("ok");
    expect(verdict({ host: "exposeme.onrender.com", origin: "https://evil.example" })).toBe("Origin not allowed");
  });

  it("no Origin on a Host outside the allowlist (bot or app aimed at another name) → refused", () => {
    expect(verdict({ host: "203.0.113.9" })).toBe("Host not allowed");
  });
});

// ── New sessions per IP (EXP-251) ──
describe("isHandshakeRequest", () => {
  it.each<[url: string, handshake: boolean]>([
    ["/socket.io/?EIO=4&transport=polling", true],
    ["/socket.io/?EIO=4&transport=websocket", true],
    ["/socket.io/?EIO=4&transport=polling&sid=abc", false],
    ["/socket.io/?EIO=4&transport=websocket&sid=abc", false],
    // engine.io: last sid wins, and an empty sid opens a new session
    ["/socket.io/?EIO=4&transport=polling&sid=", true],
    ["/socket.io/?EIO=4&transport=polling&sid", true],
    ["/socket.io/?EIO=4&transport=polling&sid=abc&sid=", true],
    ["/socket.io/?EIO=4&transport=polling&sid=&sid=abc", false],
  ])("%s → %s", (url, handshake) => {
    expect(isHandshakeRequest(url)).toBe(handshake);
  });
});

describe("createHandshakeLimit", () => {
  const request = (ip: string, url = "/socket.io/?EIO=4&transport=polling") =>
    ({ url, headers: {}, socket: { remoteAddress: ip } }) as unknown as IncomingMessage;
  const verdict = (limit: ReturnType<typeof createHandshakeLimit>, req: IncomingMessage) => {
    let result = "pending";
    limit(req, {} as ServerResponse, (err?: Error) => { result = err ? err.message : "ok"; });
    return result;
  };

  it("allows `max` new sessions per IP in the window, then refuses; other IPs and open sessions are unaffected", () => {
    vi.useFakeTimers();
    try {
      const limit = createHandshakeLimit({ max: 2, windowMs: 60_000 });
      expect(verdict(limit, request("198.51.100.1"))).toBe("ok");
      expect(verdict(limit, request("::ffff:198.51.100.1"))).toBe("ok"); // same IP key
      expect(verdict(limit, request("198.51.100.1"))).toBe("Too many handshakes");
      expect(verdict(limit, request("198.51.100.1", "/socket.io/?EIO=4&transport=polling&sid=abc"))).toBe("ok");
      expect(verdict(limit, request("198.51.100.2"))).toBe("ok");
      vi.advanceTimersByTime(60_000);
      expect(verdict(limit, request("198.51.100.1"))).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the server's limit has a generous default (a party on one IP reconnecting many times)", () => {
    expect(SOCKET_HANDSHAKE_RATE_MAX).toBeGreaterThanOrEqual(100);
  });
});

// ── Real handshakes ──
// The clients here pick their own transports and Origin, so they are opened by hand and handed to the harness to close
const harness = useTestServer();
const { clients } = harness;

afterEach(() => {
  harness.disconnectClients();
});

type Transport = "websocket" | "polling";

/** Resolves "connected" or "refused" for one handshake with the given Origin header (none when undefined). */
function handshake(transport: Transport, origin?: string): Promise<"connected" | "refused"> {
  const client = connect(harness.url, {
    transports: [transport],
    forceNew: true,
    reconnection: false,
    extraHeaders: origin === undefined ? {} : { origin },
  });
  clients.push(client);
  return new Promise((resolve) => {
    client.once("connect", () => resolve("connected"));
    client.once("connect_error", () => resolve("refused"));
  });
}

describe.each<Transport>(["websocket", "polling"])("%s handshake", (transport) => {
  it("without Origin → connected", async () => {
    expect(await handshake(transport)).toBe("connected");
  });

  it("with the server's own host as Origin → connected", async () => {
    expect(await handshake(transport, harness.url)).toBe("connected");
  });

  it("from another website's Origin → refused", async () => {
    expect(await handshake(transport, "https://evil.example")).toBe("refused");
  });
});

// The default client path: long-polling handshake without Origin, then upgrade to WebSocket (React Native's
// WebSocket adds a same-host Origin on the upgrade)
it("polling handshake without Origin, then WebSocket upgrade → connected over websocket", async () => {
  const client = connect(harness.url, { forceNew: true, reconnection: false });
  clients.push(client);
  const upgraded = new Promise<string>((resolve) => client.io.engine.once("upgrade", (t: { name: string }) => resolve(t.name)));
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  expect(await upgraded).toBe("websocket");
});

// ── Raw engine.io polling requests ──
const EVIL_ORIGIN = "https://evil.example";
const pollingUrl = (query = "") => `${harness.url}/socket.io/?EIO=4&transport=polling${query}`;

/** Opens a polling session the way a non-browser client does (no Origin) and returns its sid. */
async function openPollingSession(): Promise<string> {
  const res = await fetch(pollingUrl());
  expect(res.status).toBe(200);
  return JSON.parse((await res.text()).slice(1)).sid;
}

describe("JSONP polling", () => {
  it.each<[query: string, jsonp: boolean]>([["&j=0", true], ["&j=", true], ["", false], ["&sid=abc", false]])(
    "isJsonpRequest(…%s) → %s",
    (query, jsonp) => {
      expect(isJsonpRequest(`/socket.io/?EIO=4&transport=polling${query}`)).toBe(jsonp);
    }
  );

  // A cross-origin <script src> sends no Origin; the session id must not come back as runnable script
  it("JSONP handshake without Origin → refused, no session id", async () => {
    const res = await fetch(pollingUrl("&j=0"));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain("___eio");
    expect(body).not.toContain("sid");
  });
});

describe("requests of an open polling session", () => {
  // A foreign page that learned a sid can't drive the session with a (no-cors) POST, which always carries its Origin
  it("POST from another website's Origin → refused; the same POST without Origin → accepted", async () => {
    const sid = await openPollingSession();
    const post = (headers: Record<string, string>) =>
      fetch(pollingUrl(`&sid=${sid}`), { method: "POST", headers: { "Content-Type": "text/plain", ...headers }, body: "40" });
    expect((await post({ Origin: EVIL_ORIGIN })).status).toBe(400);
    const native = await post({});
    expect(native.status).toBe(200);
    expect(await native.text()).toBe("ok");
  });

  it("GET from another website's Origin → refused", async () => {
    const sid = await openPollingSession();
    const res = await fetch(pollingUrl(`&sid=${sid}`), { headers: { Origin: EVIL_ORIGIN } });
    expect(res.status).toBe(400);
  });
});
