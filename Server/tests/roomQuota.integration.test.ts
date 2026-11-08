import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";

// EXP-441: rooms created from one IP (IPv6: one /64, and one /48 together) are capped while they live, so one address
// can't fill MAX_ROOMS and leave everyone else with "Server is busy". Small limits so the test stays fast (read when
// the modules load).
vi.hoisted(() => {
  process.env.ROOMS_PER_IP_MAX = "3";
  process.env.ROOMS_PER_IPV6_PREFIX_MAX = "4";
  // Clients pick their IP with X-Forwarded-For (one trusted hop: the test client is the "proxy")
  process.env.TRUST_PROXY = "1";
});

import { roomManager } from "../routes/socketRoutes";
import { useTestServer } from "./socketHarness";

const harness = useTestServer({ resetBetweenTests: true });
const { once, joinAs } = harness;
const ACK_TIMEOUT_MS = 2_000;

afterEach(() => vi.restoreAllMocks());

async function clientFrom(ip: string): Promise<ClientSocket> {
  const sock = harness.connectClient({ "x-forwarded-for": ip });
  await once(sock, "connect");
  return sock;
}

/** A room created by a fresh socket from `ip`: the answer and that socket (one socket hosts one room). */
async function createFrom(ip: string, username = "host") {
  const sock = await clientFrom(ip);
  return { sock, answer: await joinAs(sock, null, username) };
}

/** Creates `n` rooms from `ip`, each on its own socket; every creation must succeed. */
async function fill(ip: string, n: number): Promise<ClientSocket[]> {
  const hosts: ClientSocket[] = [];
  for (let i = 0; i < n; i++) {
    const { sock, answer } = await createFrom(ip);
    expect(answer.success).toBe(true);
    hosts.push(sock);
  }
  return hosts;
}

describe("live rooms per IP (EXP-441)", () => {
  it("one IP gets Server is busy past its quota while another IP still creates and joins", async () => {
    await fill("203.0.113.7", 3);
    expect((await createFrom("203.0.113.7")).answer).toEqual({ success: false, message: "Server is busy" });
    expect(roomManager.isAtCapacity()).toBe(false);

    const other = await createFrom("198.51.100.9");
    expect(other.answer.success).toBe(true);
    // The capped IP can still join someone else's room
    const guest = await clientFrom("203.0.113.7");
    expect((await joinAs(guest, other.answer.room!.gameCode, "guest")).success).toBe(true);
  });

  it("a host leaving its room (now empty, so deleted at once) frees the slot", async () => {
    const [first] = await fill("203.0.113.8", 3);
    expect(roomManager.stats().rooms).toBe(3);
    await first.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room");
    expect(roomManager.stats()).toEqual({ rooms: 2, pendingDeletions: 0 });
    expect((await createFrom("203.0.113.8")).answer.success).toBe(true);
  });

  it("rooms left to their guests still count against the IP that created them", async () => {
    const { sock: host, answer } = await createFrom("203.0.113.9");
    const guest = await clientFrom("198.51.100.20");
    expect((await joinAs(guest, answer.room!.gameCode, "guest")).success).toBe(true);
    await host.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room");
    await fill("203.0.113.9", 2);
    expect((await createFrom("203.0.113.9")).answer).toEqual({ success: false, message: "Server is busy" });
  });

  it("IPv6: rotating /64s inside one /48 hits the /48's quota; another /48 still creates", async () => {
    await fill("2001:db8:1:1::10", 3);
    expect((await createFrom("2001:db8:1:1::11")).answer).toEqual({ success: false, message: "Server is busy" }); // same /64
    await fill("2001:db8:1:2::10", 1);
    expect((await createFrom("2001:db8:1:3::10")).answer).toEqual({ success: false, message: "Server is busy" }); // /48 full
    expect((await createFrom("2001:db8:2:1::10")).answer.success).toBe(true);
  });
});
