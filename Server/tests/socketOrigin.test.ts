import { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { io, server } from "../app";
import { isAllowedSocketOrigin, isJsonpRequest } from "../middlewares/socketOrigin";

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

// ── Real handshakes ──
let port: number;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  clients.splice(0).forEach((c) => c.disconnect());
});

afterAll(async () => {
  await new Promise<void>((resolve) => io.close(() => resolve()));
});

type Transport = "websocket" | "polling";

/** Resolves "connected" or "refused" for one handshake with the given Origin header (none when undefined). */
function handshake(transport: Transport, origin?: string): Promise<"connected" | "refused"> {
  const client = connect(`http://127.0.0.1:${port}`, {
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
    expect(await handshake(transport, `http://127.0.0.1:${port}`)).toBe("connected");
  });

  it("from another website's Origin → refused", async () => {
    expect(await handshake(transport, "https://evil.example")).toBe("refused");
  });
});

// The default client path: long-polling handshake without Origin, then upgrade to WebSocket (React Native's
// WebSocket adds a same-host Origin on the upgrade)
it("polling handshake without Origin, then WebSocket upgrade → connected over websocket", async () => {
  const client = connect(`http://127.0.0.1:${port}`, { forceNew: true, reconnection: false });
  clients.push(client);
  const upgraded = new Promise<string>((resolve) => client.io.engine.once("upgrade", (t: { name: string }) => resolve(t.name)));
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  expect(await upgraded).toBe("websocket");
});

// ── Raw engine.io polling requests ──
const EVIL_ORIGIN = "https://evil.example";
const pollingUrl = (query = "") => `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling${query}`;

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
