import { EventEmitter } from "events";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createInFlightLimiter } from "../middlewares/uploadInFlight";

// EXP-261: the per-IP in-flight cap (12, a full party on one Wi-Fi) let 3 IPs take all 32 server-wide slots. Once
// half the server's slots are taken, each IP is held to a smaller share, so a handful of IPs can't fill it.

const MAX = 32;
const PER_IP_MAX = 12;
const PER_IP_BUSY_MAX = 4;
const limiter = () =>
  createInFlightLimiter({
    max: MAX, perIpMax: PER_IP_MAX, perIpBusyMax: PER_IP_BUSY_MAX, perRoomMax: 100, perMemberMax: 100, timeoutMs: 60_000,
  });

/** A request whose body was already received: the in-flight limiter only listens to it. */
const req = (ip: string) =>
  Object.assign(new EventEmitter(), { ip, socket: {}, complete: true, pause() {}, resume() {} }) as unknown as Request;

function fakeRes() {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    headersSent: false,
    writableFinished: false,
    locals: {} as Record<string, unknown>,
    setHeader(k: string, v: string) { res.headers[k] = v; },
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  });
  return res;
}

let seat = 0;
/** One upload from `ip`, each from its own member and room, so only the per-IP and server-wide caps apply. */
const start = (mw: ReturnType<typeof limiter>, ip: string) => {
  const res = fakeRes();
  seat++;
  res.locals.member = { room: { gameCode: `R${seat}` }, player: { username: `p${seat}` } };
  const next = vi.fn();
  mw(req(ip), res as unknown as Response, next);
  return { admitted: next.mock.calls.length === 1, status: res.statusCode, body: res.body, finish: () => res.emit("finish") };
};
/** Tries `count` uploads from `ip`; returns the admitted ones. */
const flood = (mw: ReturnType<typeof limiter>, ip: string, count: number) =>
  Array.from({ length: count }, () => start(mw, ip)).filter((u) => u.admitted);

describe("upload in-flight slots shared between IPs (EXP-261)", () => {
  it("a full party on one Wi-Fi uploads all at once while the server is quiet", () => {
    const mw = limiter();
    expect(flood(mw, "203.0.113.1", PER_IP_MAX)).toHaveLength(PER_IP_MAX);
    const over = start(mw, "203.0.113.1");
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ scope: "ip" });
  });

  it("3 IPs uploading 12 each leave slots for other rooms", () => {
    const mw = limiter();
    for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) flood(mw, ip, PER_IP_MAX);
    expect(mw.inFlight().total).toBeLessThan(MAX);
    expect(start(mw, "192.0.2.50").admitted).toBe(true);
  });

  it("once half the slots are taken, each IP gets at most perIpBusyMax", () => {
    const mw = limiter();
    flood(mw, "198.51.100.1", PER_IP_MAX); // 12 in flight
    flood(mw, "198.51.100.2", PER_IP_MAX); // grows while under half (16), then held at 4
    expect(mw.inFlight().total).toBe(MAX / 2);
    const busy = start(mw, "198.51.100.2");
    expect(busy.status).toBe(429);
    expect(busy.body).toMatchObject({ scope: "ip" });
    expect(flood(mw, "198.51.100.3", PER_IP_MAX)).toHaveLength(PER_IP_BUSY_MAX);
  });

  it("filling every slot takes several IPs, and the last ones see 503 server busy", () => {
    const mw = limiter();
    let ips = 0;
    while (mw.inFlight().total < MAX) flood(mw, `198.51.100.${++ips}`, PER_IP_MAX);
    expect(ips).toBe(6); // 12 + 4 to reach half, then 4 per IP for the other half
    const late = start(mw, "192.0.2.99");
    expect(late.status).toBe(503);
    expect(late.body).toMatchObject({ scope: "server" });
  });

  it("an IP over the busy share grows again once the server drains below half", () => {
    const mw = limiter();
    flood(mw, "203.0.113.1", PER_IP_MAX - 1); // 11: under its own cap
    const other = flood(mw, "198.51.100.1", PER_IP_MAX); // 5, up to half the slots
    expect(mw.inFlight().total).toBe(MAX / 2);
    expect(start(mw, "203.0.113.1").admitted).toBe(false); // over the busy share
    other.forEach((u) => u.finish());
    expect(start(mw, "203.0.113.1").admitted).toBe(true);
  });

  it("without perIpBusyMax the per-IP cap stays the same however busy the server is", () => {
    const mw = createInFlightLimiter({ max: 4, perIpMax: 3, perRoomMax: 100, perMemberMax: 100, timeoutMs: 60_000 });
    expect(flood(mw, "198.51.100.1", 3)).toHaveLength(3);
  });
});
