import http from "http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { io as connect } from "socket.io-client";

// EXP-251: with ALLOWED_HOSTS set, socket.io requests whose Host is another name (e.g. a domain rebound to the
// server's IP, which also sends a matching Origin) are refused; and each IP may open at most SOCKET_HANDSHAKE_RATE_MAX
// engine.io sessions per minute (requests of an open session don't count).

vi.hoisted(() => {
  process.env.ALLOWED_HOSTS = "localhost";
  process.env.SOCKET_HANDSHAKE_RATE_MAX = "3";
  // Client IP from X-Forwarded-For, so each test acts from its own IP
  process.env.TRUST_PROXY = "1";
});

import { ALLOWED_HOSTS, SOCKET_HANDSHAKE_RATE_MAX } from "../middlewares/socketOrigin";
import { useTestServer } from "./socketHarness";

// The clients here pick their own Host and transports, so they are opened by hand and handed to the harness to close
const harness = useTestServer();
const { clients } = harness;

afterEach(() => {
  harness.disconnectClients();
});

/**
 * Raw polling handshake with explicit Host/Origin/X-Forwarded-For headers (and `extraQuery`, e.g. an empty sid) or,
 * with `sid`, a POST of that open session (the socket.io CONNECT packet; a GET would long-poll).
 */
function pollingRequest(
  headers: Record<string, string>,
  { sid, extraQuery = "" }: { sid?: string; extraQuery?: string } = {}
): Promise<{ status: number; body: string }> {
  const path = `/socket.io/?EIO=4&transport=polling${sid ? `&sid=${sid}` : ""}${extraQuery}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: harness.port, path, headers, method: sid ? "POST" : "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(sid ? "40" : undefined);
  });
}

const sidOf = (body: string): string => JSON.parse(body.slice(1)).sid;

/** socket.io client handshake over WebSocket to `host`; "connected" or "refused". */
function handshake(host: string, ip: string): Promise<"connected" | "refused"> {
  const client = connect(`http://${host}:${harness.port}`, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    extraHeaders: { "x-forwarded-for": ip },
  });
  clients.push(client);
  return new Promise((resolve) => {
    client.once("connect", () => resolve("connected"));
    client.once("connect_error", () => resolve("refused"));
  });
}

describe("ALLOWED_HOSTS", () => {
  it("is read from the environment", () => {
    expect(ALLOWED_HOSTS).toEqual(new Set(["localhost"]));
  });

  it("the allowlisted name connects; the same server reached by another name (its IP) is refused", async () => {
    expect(await handshake("localhost", "198.51.100.10")).toBe("connected");
    expect(await handshake("127.0.0.1", "198.51.100.11")).toBe("refused");
  });

  it("DNS rebinding: Host and Origin both naming another domain → 400, no session", async () => {
    const res = await pollingRequest({
      host: `rebind.evil.example:${harness.port}`,
      origin: `http://rebind.evil.example:${harness.port}`,
      "x-forwarded-for": "198.51.100.12",
    });
    expect(res.status).toBe(400);
    expect(res.body).not.toContain("sid");
  });
});

describe("new engine.io sessions per IP", () => {
  it("SOCKET_HANDSHAKE_RATE_MAX handshakes per IP per minute, then 400; open sessions and other IPs unaffected", async () => {
    expect(SOCKET_HANDSHAKE_RATE_MAX).toBe(3);
    const from = (ip: string) => ({ host: `localhost:${harness.port}`, "x-forwarded-for": ip });
    const opened = [];
    for (let i = 0; i < SOCKET_HANDSHAKE_RATE_MAX; i++) {
      const res = await pollingRequest(from("198.51.100.20"));
      expect(res.status).toBe(200);
      opened.push(sidOf(res.body));
    }
    const over = await pollingRequest(from("198.51.100.20"));
    expect(over.status).toBe(400);
    expect(over.body).not.toContain("sid");
    // A session it already has keeps working (its requests carry the sid)
    expect(await pollingRequest(from("198.51.100.20"), { sid: opened[0] })).toEqual({ status: 200, body: "ok" });
    expect((await pollingRequest(from("198.51.100.21"))).status).toBe(200);
  });

  // engine.io opens a new session for an empty sid (last one wins), so those count as handshakes too
  it.each([["&sid="], ["&sid"], ["&sid=abc&sid="]])("handshakes with %s count; over the limit → 400", async (extraQuery) => {
    const ip = `198.51.100.${40 + extraQuery.length}`;
    const headers = { host: `localhost:${harness.port}`, "x-forwarded-for": ip };
    for (let i = 0; i < SOCKET_HANDSHAKE_RATE_MAX; i++) {
      const res = await pollingRequest(headers, { extraQuery });
      expect(res.status).toBe(200);
      expect(sidOf(res.body)).toBeTruthy(); // a new session was opened
    }
    const over = await pollingRequest(headers, { extraQuery });
    expect(over.status).toBe(400);
    expect(over.body).not.toContain("sid");
  });

  it("the app's default path (polling handshake, then WebSocket upgrade) counts one handshake per client", async () => {
    const ip = "198.51.100.60";
    const upgradedClient = () => {
      const client = connect(`http://localhost:${harness.port}`, { forceNew: true, reconnection: false, extraHeaders: { "x-forwarded-for": ip } });
      clients.push(client);
      return new Promise<string>((resolve) => {
        client.once("connect_error", () => resolve("refused"));
        client.io.engine?.once("upgrade", (t: { name: string }) => resolve(t.name));
      });
    };
    for (let i = 0; i < SOCKET_HANDSHAKE_RATE_MAX; i++) expect(await upgradedClient()).toBe("websocket");
    expect(await upgradedClient()).toBe("refused");
  });

  it("refused requests (Host not allowed) don't use up the IP's handshakes", async () => {
    for (let i = 0; i < SOCKET_HANDSHAKE_RATE_MAX + 2; i++) {
      expect((await pollingRequest({ host: `127.0.0.1:${harness.port}`, "x-forwarded-for": "198.51.100.30" })).status).toBe(400);
    }
    expect(await handshake("localhost", "198.51.100.30")).toBe("connected");
  });
});
