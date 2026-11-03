import { FakeSocket } from "../testUtils/fakeSocket";
import en from "../src/i18n/en";
import es from "../src/i18n/es";
import { AckSocket } from "../src/utils/socketAck";
import { canOfferStart, sendStartGame, START_ACK_TIMEOUT_MS, startNoticeText } from "../src/utils/startGame";

// EXP-379: start-game resolves with the server's ack (or null when none came), the host is only offered Start with 2
// players who are not gone, and a start that didn't happen is explained.

const fakeSocket = () => new FakeSocket() as FakeSocket & AckSocket;
const lastAck = (socket: FakeSocket) => {
  const sent = socket.emitted[socket.emitted.length - 1];
  return sent[sent.length - 1] as (answer: unknown) => void;
};
const player = (username: string, connected = true) =>
  ({ username, points: 0, isHost: false, connected, lastAnswerCorrect: false, lastGuess: "" });

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe("sendStartGame", () => {
  it("sends start-game with only an ack callback and resolves with the server's answer", async () => {
    const socket = fakeSocket();
    const answer = sendStartGame(socket);
    expect(socket.emitted).toHaveLength(1);
    expect(socket.emitted[0]).toEqual(["start-game", expect.any(Function)]);
    lastAck(socket)({ ok: false, reason: "not-enough-players", removed: ["bob"] });
    await expect(answer).resolves.toEqual({ ok: false, reason: "not-enough-players", removed: ["bob"] });
    expect(socket.listenerCount("disconnect")).toBe(0);
  });

  it("null when not connected (never emitted), on a disconnect, after the timeout and on a malformed answer", async () => {
    const socket = fakeSocket();
    socket.connected = false;
    await expect(sendStartGame(socket)).resolves.toBeNull();
    expect(socket.emitted).toEqual([]);

    socket.connected = true;
    const dropped = sendStartGame(socket);
    socket.fire("disconnect");
    await expect(dropped).resolves.toBeNull();

    const timedOut = sendStartGame(socket);
    jest.advanceTimersByTime(START_ACK_TIMEOUT_MS);
    await expect(timedOut).resolves.toBeNull();

    const malformed = sendStartGame(socket);
    lastAck(socket)("ok");
    await expect(malformed).resolves.toBeNull();
    expect(socket.listenerCount("disconnect")).toBe(0);
  });
});

describe("canOfferStart", () => {
  it("needs 2 players who are not gone", () => {
    expect(canOfferStart([player("alice")])).toBe(false);
    expect(canOfferStart([player("alice"), player("bob", false)])).toBe(false);
    expect(canOfferStart([player("alice"), player("bob")])).toBe(true);
    expect(canOfferStart([player("alice"), player("bob"), player("carol", false)])).toBe(true);
  });
});

describe("startNoticeText", () => {
  it("names the one gone player the start removed", () => {
    expect(startNoticeText({ ok: false, reason: "not-enough-players", removed: ["Ana"] }, en))
      .toBe("Ana was disconnected and has left the room.");
    expect(startNoticeText({ ok: false, reason: "not-enough-players", removed: ["Ana"] }, es))
      .toBe("Ana se había desconectado y ha salido de la sala.");
  });

  it("inserts a name as is, even one that looks like a replacement pattern", () => {
    for (const name of ["$&x", "a$'b", "$`", "$$"]) {
      expect(startNoticeText({ ok: false, reason: "not-enough-players", removed: [name] }, en))
        .toBe(`${name} was disconnected and has left the room.`);
    }
  });

  it("several removed, nobody removed, and every other failure", () => {
    expect(startNoticeText({ ok: false, reason: "not-enough-players", removed: ["Ana", "Bob"] }, en)).toBe(en.startRefusedPlayersGone);
    expect(startNoticeText({ ok: false, reason: "not-enough-players", removed: [] }, en)).toBe(en.startRefusedNotEnoughPlayers);
    expect(startNoticeText(null, en)).toBe(en.startGameFailed); // no answer
    expect(startNoticeText({ ok: false, reason: "not-host" }, en)).toBe(en.startGameFailed);
    expect(startNoticeText({ ok: false, reason: "not-in-room" }, en)).toBe(en.startGameFailed);
  });

  it("nothing to say when it started, or a game is already running", () => {
    expect(startNoticeText({ ok: true }, en)).toBeNull();
    expect(startNoticeText({ ok: false, reason: "already-started" }, en)).toBeNull();
  });
});
