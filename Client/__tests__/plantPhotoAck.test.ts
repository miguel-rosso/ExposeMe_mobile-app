import { FakeSocket } from "../testUtils/fakeSocket";
import {
  isFinalRefusal, isPhotoUnavailable, PLANT_ACK_TIMEOUT_MS, PlantingSocket, PlantPhotoAck, sendPlantPhoto,
} from "../src/utils/plantPhotoAck";

// EXP-152: plant-photo resolves with the server's ack, or null when the server may not have the photo.

const URL = "/temp/" + "a".repeat(32) + ".jpg";
const fakeSocket = () => new FakeSocket() as FakeSocket & PlantingSocket;
const lastAck = (socket: FakeSocket) => socket.emitted[socket.emitted.length - 1][2] as (answer: unknown) => void;

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe("sendPlantPhoto", () => {
  it("resolves with the server's ack and stops listening", async () => {
    const socket = fakeSocket();
    const answer = sendPlantPhoto(socket, URL);
    expect(socket.emittedPayloads("plant-photo")).toEqual([{ photoUrl: URL }]);
    lastAck(socket)({ ok: false, reason: "too-late" });
    await expect(answer).resolves.toEqual({ ok: false, reason: "too-late" });
    expect(socket.listenerCount("disconnect")).toBe(0);
  });

  it("not connected: never emitted (socket.io would buffer it), null", async () => {
    const socket = fakeSocket();
    socket.connected = false;
    await expect(sendPlantPhoto(socket, URL)).resolves.toBeNull();
    expect(socket.emitted).toEqual([]);
  });

  it("null after the timeout, and on a malformed answer", async () => {
    const socket = fakeSocket();
    const timedOut = sendPlantPhoto(socket, URL);
    jest.advanceTimersByTime(PLANT_ACK_TIMEOUT_MS);
    await expect(timedOut).resolves.toBeNull();
    expect(socket.listenerCount("disconnect")).toBe(0);

    const malformed = sendPlantPhoto(socket, URL);
    lastAck(socket)("ok");
    await expect(malformed).resolves.toBeNull();
  });

  it("an ack after the timeout goes to onLateAck (a malformed one doesn't); one in time doesn't", async () => {
    const socket = fakeSocket();
    const onLateAck = jest.fn();
    const timedOut = sendPlantPhoto(socket, URL, { timeoutMs: 100, onLateAck });
    jest.advanceTimersByTime(100);
    await expect(timedOut).resolves.toBeNull();
    lastAck(socket)("ok");
    expect(onLateAck).not.toHaveBeenCalled();
    lastAck(socket)({ ok: true });
    expect(onLateAck).toHaveBeenCalledWith({ ok: true });

    onLateAck.mockClear();
    const inTime = sendPlantPhoto(socket, URL, { onLateAck });
    lastAck(socket)({ ok: true });
    await expect(inTime).resolves.toEqual({ ok: true });
    expect(onLateAck).not.toHaveBeenCalled();
  });

  it("null as soon as the connection drops", async () => {
    const socket = fakeSocket();
    const answer = sendPlantPhoto(socket, URL);
    socket.fire("disconnect", "transport close");
    await expect(answer).resolves.toBeNull();
  });
});

describe("ack classification", () => {
  const refused = (reason: Extract<PlantPhotoAck, { ok: false }>["reason"]): PlantPhotoAck => ({ ok: false, reason });

  it("only photo-unavailable asks for a new upload", () => {
    expect(isPhotoUnavailable(refused("photo-unavailable"))).toBe(true);
    for (const ack of [refused("too-late"), refused("not-in-room"), { ok: true } as const, null]) {
      expect(isPhotoUnavailable(ack)).toBe(false);
    }
  });

  it("final: refused other than not-in-room; no answer or ok are not", () => {
    for (const r of ["photo-unavailable", "too-late", "invalid"] as const) expect(isFinalRefusal(refused(r))).toBe(true);
    for (const ack of [refused("not-in-room"), { ok: true } as const, null]) expect(isFinalRefusal(ack)).toBe(false);
  });
});
