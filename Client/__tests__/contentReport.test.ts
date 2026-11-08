import { FakeSocket } from "../testUtils/fakeSocket";
import type { AckSocket } from "../src/utils/socketAck";
import {
  playerMutedByReport, REPORT_ACK_TIMEOUT_MS, reportedPlayer, reportPayload, roundPhotoReport, sendContentReport,
  withRevealedOwner,
} from "../src/utils/contentReport";

// EXP-423: what a report sends and what the round photo's report button points at. The dialog flows are covered by
// gameReportPhoto.test.tsx and waitingRoomReportMessage.test.tsx.

const fakeSocket = () => new FakeSocket() as FakeSocket & AckSocket;
const round = { photo: "/temp/1.jpg", round: 3, phase: "answering" as const, correctAnswer: "" };

describe("reportPayload", () => {
  it("a photo: its round and the reason, never whose it is", () => {
    expect(reportPayload({ kind: "photo", round: 3, owner: "bob" }, "sexual")).toEqual({ kind: "photo", round: 3, reason: "sexual" });
  });

  it("a message: its author and text, as relayed", () => {
    expect(reportPayload({ kind: "message", author: "bob", text: "hi" }, "harassment"))
      .toEqual({ kind: "message", author: "bob", text: "hi", reason: "harassment" });
  });
});

describe("roundPhotoReport", () => {
  it("while answering: the round, owner unknown", () => {
    const target = roundPhotoReport(round, "alice");
    expect(target).toEqual({ kind: "photo", round: 3 });
    expect(reportedPlayer(target!)).toBeUndefined();
  });

  it("revealed: the round and its owner", () => {
    for (const phase of ["reveal", "scores"] as const) {
      const target = roundPhotoReport({ ...round, phase, correctAnswer: "bob" }, "alice");
      expect(target).toEqual({ kind: "photo", round: 3, owner: "bob" });
      expect(reportedPlayer(target!)).toBe("bob");
    }
  });

  it("nothing to report: no photo, a photo wait, or my own photo revealed", () => {
    expect(roundPhotoReport({ ...round, photo: null }, "alice")).toBeNull();
    expect(roundPhotoReport({ ...round, phase: "waiting-photo" }, "alice")).toBeNull();
    expect(roundPhotoReport({ ...round, phase: null }, "alice")).toBeNull();
    expect(roundPhotoReport({ ...round, phase: "reveal", correctAnswer: "alice" }, "alice")).toBeNull();
  });
});

describe("playerMutedByReport (EXP-438)", () => {
  it("a message's author, or a photo's owner once revealed", () => {
    expect(playerMutedByReport({ kind: "message", author: "bob", text: "hi" }, "alice")).toBe("bob");
    expect(playerMutedByReport({ kind: "photo", round: 3, owner: "bob" }, "alice")).toBe("bob");
  });

  it("nobody: a photo whose owner is still secret, or content of mine", () => {
    expect(playerMutedByReport({ kind: "photo", round: 3 }, "alice")).toBeNull();
    expect(playerMutedByReport({ kind: "photo", round: 3, owner: "alice" }, "alice")).toBeNull();
    expect(playerMutedByReport({ kind: "message", author: "alice", text: "hi" }, "alice")).toBeNull();
  });
});

describe("withRevealedOwner (EXP-438)", () => {
  const before = { kind: "photo" as const, round: 3 };

  it("a photo picked before its reveal takes the owner of the same round's photo revealed since", () => {
    expect(withRevealedOwner(before, { kind: "photo", round: 3, owner: "bob" })).toEqual({ ...before, owner: "bob" });
  });

  it("anything else stays as it is: still secret, another round, nothing on screen, a known owner, a message", () => {
    expect(withRevealedOwner(before, { kind: "photo", round: 3 })).toBe(before);
    expect(withRevealedOwner(before, { kind: "photo", round: 4, owner: "bob" })).toBe(before);
    expect(withRevealedOwner(before, null)).toBe(before);
    const known = { kind: "photo" as const, round: 3, owner: "carol" };
    expect(withRevealedOwner(known, { kind: "photo", round: 3, owner: "bob" })).toBe(known);
    const message = { kind: "message" as const, author: "bob", text: "hi" };
    expect(withRevealedOwner(message, { kind: "photo", round: 3, owner: "carol" })).toBe(message);
  });
});

describe("sendContentReport", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("emits report-content with the payload and resolves the server's ack", async () => {
    const socket = fakeSocket();
    const sent = sendContentReport(socket, { kind: "photo", round: 1 }, "other");
    const [[event, payload, ack]] = socket.emitted;
    expect([event, payload]).toEqual(["report-content", { kind: "photo", round: 1, reason: "other" }]);
    ack({ ok: false, reason: "not-found" });
    await expect(sent).resolves.toEqual({ ok: false, reason: "not-found" });
  });

  it("no ack within REPORT_ACK_TIMEOUT_MS, or offline: null", async () => {
    const socket = fakeSocket();
    const late = sendContentReport(socket, { kind: "photo", round: 1 }, "other");
    jest.advanceTimersByTime(REPORT_ACK_TIMEOUT_MS);
    await expect(late).resolves.toBeNull();

    socket.connected = false;
    await expect(sendContentReport(socket, { kind: "photo", round: 1 }, "other")).resolves.toBeNull();
    expect(socket.emitted).toHaveLength(1);
  });
});
