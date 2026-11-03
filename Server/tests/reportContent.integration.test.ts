import fs from "fs";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import sharp from "sharp";
import { useTestServer } from "./socketHarness";
import { reportStore, StoredReport } from "../managers/reportStore";
import { MAX_PHOTO_COPIES_PER_GAME } from "../managers/reportLedger";

// EXP-423 (DEC-052 A): report-content over a real socket. The reporter and the room come from the session (forged
// fields are ignored), a report must point at content another player really sent in the reporter's own room, every
// report is acked, at most 5 at once per socket, and an accepted one is stored with a copy of the reported photo.

const DIRS = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const root = `${tmp}/exposeme-report-content-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = `${root}/uploads`;
  process.env.REPORTS_FILE = `${root}/reports/reports.jsonl`;
  delete process.env.REPORT_WEBHOOK_URL;
  return { root, reportsFile: process.env.REPORTS_FILE };
});

const ACK_TIMEOUT_MS = 2_000;
const REPORT_BURST = 5;

interface Member { name: string; socket: ClientSocket; token: string; gameCode: string }
type Ack = { ok: boolean; reason?: string };

const harness = useTestServer({ resetBetweenTests: true });
const { once, newClient, joinAs } = harness;
let jpeg: Buffer;
let randomSpy: { mockRestore(): void } | undefined;

async function createRoom(...names: string[]): Promise<Member[]> {
  const members: Member[] = [];
  let gameCode: string | null = null;
  for (const name of names) {
    const socket = await newClient();
    const r = await joinAs(socket, gameCode, name);
    expect(r.success).toBe(true);
    gameCode = r.room!.gameCode;
    members.push({ name, socket, token: r.rejoinToken!, gameCode });
  }
  return members;
}

/** Sends report-content and resolves its ack, or null when none comes within ACK_TIMEOUT_MS. */
function report(socket: ClientSocket, payload: unknown): Promise<Ack | null> {
  return socket.timeout(ACK_TIMEOUT_MS).emitWithAck("report-content", payload).catch(() => null);
}

const storedReports = (): StoredReport[] => fs.existsSync(DIRS.reportsFile)
  ? fs.readFileSync(DIRS.reportsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

/** `sender` says `message` in the chat; resolves once `listener` got it (the server logged it before relaying on). */
async function say(sender: Member, listener: Member, message: string): Promise<void> {
  const relayed = once(listener.socket, "chat-message");
  sender.socket.emit("chat-message", { message });
  await relayed;
}

// Round 1 answering (8.5 s) + reveal (3 s) + scores (5 s) before round 2's photo request, plus margin
const NEXT_TURN_TIMEOUT_MS = 22_000;

/** The host (first member) owns round 1 and plays it with an uploaded photo; resolves the photo path. */
async function playRoundOne(members: Member[]): Promise<string> {
  randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
  const [host] = members;
  await harness.startGame(host.socket, members.map((m) => m.socket));
  const turn = once(host.socket, "your-turn");
  members.forEach((m) => m.socket.emit("im-ready"));
  await turn;
  return sendHostPhoto(members, 1);
}

/** The host, awaited for round `round`'s photo, uploads one and sends it; resolves its path once the round starts. */
async function sendHostPhoto(members: Member[], round: number): Promise<string> {
  const [host, ...others] = members;
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "p.jpg");
  const res = await fetch(`${harness.url}/upload`, {
    method: "POST", body: form, headers: { Authorization: `Bearer ${host.token}`, "X-Game-Code": host.gameCode },
  });
  const { url } = (await res.json()) as { url: string };
  const start = once<{ photo: string; round: number }>(others[0].socket, "round-start");
  host.socket.emit("photo-sent", { photo: url });
  expect(await start).toMatchObject({ photo: url, round });
  return url;
}

beforeAll(async () => {
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#a33" } }).jpeg().toBuffer();
});

afterEach(async () => {
  randomSpy?.mockRestore();
  randomSpy = undefined;
  // A report accepted at the end of a test is still being written: done before its files go, never in the next test
  await reportStore.flush();
  fs.rmSync(path.dirname(DIRS.reportsFile), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(DIRS.root, { recursive: true, force: true });
});

describe("report-content: who may report what", () => {
  it("a socket in no room: not-in-room", async () => {
    const stranger = await newClient();
    expect(await report(stranger, { kind: "photo", reason: "sexual", round: 1 })).toEqual({ ok: false, reason: "not-in-room" });
  });

  it("a malformed payload: invalid, nothing stored", async () => {
    const [alice] = await createRoom("alice", "bob");
    for (const payload of [
      null, "photo", { kind: "photo", reason: "spam", round: 1 }, { kind: "photo", reason: "other", round: 0 },
      { kind: "message", reason: "other", author: "bob" },
    ]) {
      expect(await report(alice.socket, payload)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(storedReports()).toEqual([]);
  });

  it("another player's message: stored with its text, the reporter and room from the session", async () => {
    const [alice, bob] = await createRoom("alice", "bob");
    await say(alice, bob, "you are awful");
    const forged = { gameCode: "ZZZZZZ", username: "alice", reporter: "carol", reported: "dave" };
    expect(await report(bob.socket, { ...forged, kind: "message", reason: "harassment", author: "alice", text: "you are awful" }))
      .toEqual({ ok: true });
    await vi.waitFor(() => expect(storedReports()).toHaveLength(1));
    expect(storedReports()[0]).toMatchObject({
      roomCode: alice.gameCode, round: null, reporter: "bob", reported: "alice", kind: "message", reason: "harassment",
      text: "you are awful", photoFile: null,
    });
  });

  it("a masked message (EXP-424): reported as the room got it, masked, and stored that way", async () => {
    const [alice, bob] = await createRoom("alice", "bob");
    const relayed = once<{ username: string; message: string }>(bob.socket, "chat-message");
    const acked = alice.socket.timeout(ACK_TIMEOUT_MS).emitWithAck("chat-message", { message: "eres una puta" });
    const { message: masked } = await relayed;
    expect(masked).toBe("eres una p***");
    expect(await acked).toEqual({ message: masked });

    expect(await report(bob.socket, { kind: "message", reason: "harassment", author: "alice", text: masked }))
      .toEqual({ ok: true });
    // The unmasked words were never shown to anyone: they aren't a message of the room
    expect(await report(bob.socket, { kind: "message", reason: "harassment", author: "alice", text: "eres una puta" }))
      .toEqual({ ok: false, reason: "not-found" });
    await vi.waitFor(() => expect(storedReports()).toHaveLength(1));
    expect(storedReports()[0]).toMatchObject({ reporter: "bob", reported: "alice", kind: "message", text: masked });
  });

  it("words nobody said, or the reporter's own message: not-found", async () => {
    const [alice, bob] = await createRoom("alice", "bob");
    await say(alice, bob, "hello");
    await say(bob, alice, "hi");
    expect(await report(bob.socket, { kind: "message", reason: "other", author: "alice", text: "something worse" }))
      .toEqual({ ok: false, reason: "not-found" });
    expect(await report(bob.socket, { kind: "message", reason: "other", author: "bob", text: "hi" }))
      .toEqual({ ok: false, reason: "not-found" });
    expect(storedReports()).toEqual([]);
  });

  it("a message of another room is never found from this one", async () => {
    const [alice, bob] = await createRoom("alice", "bob");
    const [carol] = await createRoom("carol", "dave");
    await say(alice, bob, "only in alice's room");
    expect(await report(carol.socket, { gameCode: alice.gameCode, kind: "message", reason: "other", author: "alice", text: "only in alice's room" }))
      .toEqual({ ok: false, reason: "not-found" });
  });

  it("the round photo: stored with a copy of the photo, which outlives its upload", async () => {
    const members = await createRoom("alice", "bob", "carol");
    const photo = await playRoundOne(members);
    const [alice, bob] = members;
    expect(await report(bob.socket, { kind: "photo", reason: "sexual", round: 1, reporter: "carol" })).toEqual({ ok: true });
    await vi.waitFor(() => expect(storedReports()).toHaveLength(1));
    const [stored] = storedReports();
    const name = path.basename(photo);
    expect(stored).toMatchObject({
      roomCode: alice.gameCode, round: 1, reporter: "bob", reported: "alice", kind: "photo", reason: "sexual", text: null,
      photoFile: name,
    });
    fs.unlinkSync(path.join(process.env.UPLOAD_DIR!, name));
    expect(fs.existsSync(path.join(path.dirname(DIRS.reportsFile), "photos", name))).toBe(true);
  }, 15_000);

  it("the same photo reported again by the same player: acked the same, stored once; never logged", async () => {
    const members = await createRoom("alice", "bob", "carol");
    await playRoundOne(members);
    const [, bob, carol] = members;
    const log = vi.mocked(console.log);
    log.mockClear();
    expect(await report(bob.socket, { kind: "photo", reason: "sexual", round: 1 })).toEqual({ ok: true });
    expect(await report(bob.socket, { kind: "photo", reason: "violence", round: 1 })).toEqual({ ok: true });
    expect(await report(carol.socket, { kind: "photo", reason: "other", round: 1 })).toEqual({ ok: true });
    await vi.waitFor(() => expect(storedReports().map((r) => r.reporter)).toEqual(["bob", "carol"]));
    // Any line about it would pair with the round's "photo from <owner>" line: a report leaves none
    expect(log.mock.calls.map((args) => String(args[0])).filter((line) => /report/i.test(line))).toEqual([]);
  }, 15_000);

  it(`a photo reported by many players counts once towards the game's ${MAX_PHOTO_COPIES_PER_GAME} photos kept`, async () => {
    const reporters = Array.from({ length: MAX_PHOTO_COPIES_PER_GAME + 1 }, (_, i) => `p${i + 1}`);
    const members = await createRoom("alice", ...reporters);
    const first = await playRoundOne(members);
    for (const m of members.slice(1)) {
      expect(await report(m.socket, { kind: "photo", reason: "sexual", round: 1 })).toEqual({ ok: true });
    }
    await once(members[0].socket, "your-turn", NEXT_TURN_TIMEOUT_MS); // alice owns round 2 too
    const second = await sendHostPhoto(members, 2);
    expect(await report(members[1].socket, { kind: "photo", reason: "sexual", round: 2 })).toEqual({ ok: true });
    await vi.waitFor(() => expect(storedReports()).toHaveLength(reporters.length + 1));
    expect(storedReports().map((r) => r.photoFile)).toEqual([
      ...reporters.map(() => path.basename(first)), path.basename(second),
    ]);
  }, 40_000);

  it("the disk refusing the photo (ENOSPC): the report is stored without it and acked, the error code alone logged", async () => {
    const members = await createRoom("alice", "bob");
    await playRoundOne(members);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const keep = vi.spyOn(reportStore, "keepPhoto").mockImplementation(() => {
      throw Object.assign(new Error("no space left on /secret/path"), { code: "ENOSPC" });
    });
    try {
      expect(await report(members[1].socket, { kind: "photo", reason: "sexual", round: 1 })).toEqual({ ok: true });
      await vi.waitFor(() => expect(storedReports()).toHaveLength(1));
      expect(storedReports()[0]).toMatchObject({ reporter: "bob", round: 1, photoFile: null });
      expect(error).toHaveBeenCalledWith("Reported photo not kept:", "ENOSPC");
      expect(error.mock.calls.flat().join(" ")).not.toContain("/secret/path");
    } finally {
      keep.mockRestore();
      error.mockRestore();
    }
  }, 15_000);

  it("a report that failed before being stored (no ack) is stored when sent again, not taken for a repeat", async () => {
    const [alice, bob] = await createRoom("alice", "bob");
    await say(alice, bob, "hello there");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi.spyOn(reportStore, "save").mockImplementationOnce(() => { throw new Error("disk gone"); });
    try {
      expect(await report(bob.socket, { kind: "message", reason: "other", author: "alice", text: "hello there" })).toBeNull();
      expect(await report(bob.socket, { kind: "message", reason: "other", author: "alice", text: "hello there" }))
        .toEqual({ ok: true });
      await vi.waitFor(() => expect(storedReports().map((r) => r.text)).toEqual(["hello there"]));
    } finally {
      save.mockRestore();
      error.mockRestore();
    }
  });

  it("a player who joined after a message can't report it", async () => {
    const [alice, bob] = await createRoom("alice", "bob");
    await say(alice, bob, "said before carol came");
    const carol = await newClient();
    expect((await joinAs(carol, alice.gameCode, "carol")).success).toBe(true);
    expect(await report(carol, { kind: "message", reason: "other", author: "alice", text: "said before carol came" }))
      .toEqual({ ok: false, reason: "not-found" });
    expect(await report(bob.socket, { kind: "message", reason: "other", author: "alice", text: "said before carol came" }))
      .toEqual({ ok: true });
    await vi.waitFor(() => expect(storedReports().map((r) => r.reporter)).toEqual(["bob"]));
  });

  it("a round not played, the owner's own photo, or a room the reporter isn't in: not-found", async () => {
    const members = await createRoom("alice", "bob");
    await playRoundOne(members);
    const [alice, bob] = members;
    expect(await report(bob.socket, { kind: "photo", reason: "other", round: 2 })).toEqual({ ok: false, reason: "not-found" });
    expect(await report(alice.socket, { kind: "photo", reason: "other", round: 1 })).toEqual({ ok: false, reason: "not-found" });
    // A player of another room naming alice's room: the report is about their own room, where round 1 wasn't played
    const [carol] = await createRoom("carol", "dave");
    expect(await report(carol.socket, { gameCode: alice.gameCode, kind: "photo", reason: "other", round: 1 }))
      .toEqual({ ok: false, reason: "not-found" });
    expect(storedReports()).toEqual([]);
  }, 15_000);
});

describe("report-content: rate limit", () => {
  it(`acks ${REPORT_BURST} reports at once per socket; the next one is dropped without an ack`, async () => {
    const [alice, bob] = await createRoom("alice", "bob");
    for (let i = 0; i < REPORT_BURST; i++) {
      expect(await report(alice.socket, { kind: "photo", reason: "other", round: 1 })).toEqual({ ok: false, reason: "not-found" });
    }
    expect(await report(alice.socket, { kind: "photo", reason: "other", round: 1 })).toBeNull();
    // Per socket: the room's other player still reports
    expect(await report(bob.socket, { kind: "photo", reason: "other", round: 1 })).toEqual({ ok: false, reason: "not-found" });
  });
});
