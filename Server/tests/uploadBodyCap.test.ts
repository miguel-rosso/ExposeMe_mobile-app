import { EventEmitter } from "events";
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OVER_CAP_CLOSE_DELAY_MS, UNREAD_BODY_GRACE_MS } from "../middlewares/unreadBody";
import { createInFlightLimiter, MAX_UPLOAD_BODY_BYTES, MAX_UPLOAD_WIRE_BYTES } from "../middlewares/uploadInFlight";

// EXP-442: the in-flight limiter counts an admitted upload's body bytes as they are read, without starting to read
// the body itself, and aborts the upload with 413 once they pass MAX_UPLOAD_BODY_BYTES, or once the bytes read off
// the connection since admission pass MAX_UPLOAD_WIRE_BYTES.
// EXP-449: a cut upload's connection is ended right after its response and only closed UNREAD_BODY_GRACE_MS later, so
// the client reads the answer; and an upload's slot (and its timeout) is held until its body stops arriving, also when
// it was answered early.

const TIMEOUT_MS = 60_000;
const limiter = () => createInFlightLimiter({ max: 10, perIpMax: 10, perRoomMax: 10, perMemberMax: 10, timeoutMs: TIMEOUT_MS });

/** The parts of a net.Socket the limiter uses: closing it emits "close", like the real one. */
function fakeSocket(bytesRead: number) {
  const socket = Object.assign(new EventEmitter(), {
    bytesRead,
    destroyed: false,
    end: vi.fn(),
    pause: vi.fn(),
    destroy: vi.fn(() => {
      if (socket.destroyed) return;
      socket.destroyed = true;
      socket.emit("close");
    }),
    /** net.Socket's own: ends our side, then destroys the socket once that is flushed (here, at once). */
    destroySoon: () => {
      socket.end();
      socket.destroy();
    },
  });
  return socket;
}

/** Admits an upload on a connection that has already read `wireBefore` bytes (its head, earlier keep-alive requests). */
function admit(wireBefore = 0) {
  const req = Object.assign(new EventEmitter(), {
    ip: "198.51.100.9",
    complete: false,
    socket: fakeSocket(wireBefore),
    pause: vi.fn(),
    resume: vi.fn(),
    unpipe: vi.fn(),
  });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    headersSent: false,
    writableFinished: false,
    locals: { member: { room: { gameCode: "R1" }, player: { username: "p1" } } },
    setHeader(k: string, v: string) { res.headers[k] = v; },
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; res.headersSent = true; return res; },
  });
  const mw = limiter();
  const next = vi.fn();
  mw(req as unknown as Request, res as unknown as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  /**
   * The response has been written out: like Node's HTTP server, closes the socket with destroySoon() first if it was
   * a `Connection: close` response, then emits "finish" and "close".
   */
  const finish = () => {
    res.writableFinished = true;
    if (res.headers.Connection === "close") req.socket.destroySoon();
    res.emit("finish");
    res.emit("close");
  };
  /** The rest of the body arrived and was read. */
  const endBody = () => {
    req.complete = true;
    req.emit("end");
  };
  return { mw, req, res, finish, endBody };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("upload body byte cap", () => {
  it("doesn't start reading the body when it starts counting it", () => {
    const { req } = admit();
    expect(req.pause).toHaveBeenCalled();
    expect(req.resume).not.toHaveBeenCalled();
  });

  it("lets a body up to the cap through", () => {
    const { req, res } = admit();
    req.socket.bytesRead = MAX_UPLOAD_WIRE_BYTES;
    req.emit("data", Buffer.alloc(MAX_UPLOAD_BODY_BYTES));
    expect(res.body).toBeUndefined();
    expect(req.socket.end).not.toHaveBeenCalled();
    expect(req.socket.destroy).not.toHaveBeenCalled();
  });

  it("answers 413 past the cap, ends the connection after the response and closes it after the grace period", () => {
    const { mw, req, res, finish } = admit();
    req.emit("data", Buffer.alloc(MAX_UPLOAD_BODY_BYTES));
    req.emit("data", Buffer.alloc(1));
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ error: "File too large" });
    expect(res.headers.Connection).toBe("close");
    expect(req.socket.end).not.toHaveBeenCalled();

    finish();
    expect(req.socket.end).toHaveBeenCalled();
    expect(req.socket.destroy).not.toHaveBeenCalled();
    expect(mw.inFlight().total).toBe(1); // the body is still arriving
    req.emit("data", Buffer.alloc(1)); // bytes still arriving don't answer twice
    expect(res.statusCode).toBe(413);

    vi.advanceTimersByTime(UNREAD_BODY_GRACE_MS - 1);
    expect(req.socket.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(req.socket.destroy).toHaveBeenCalledTimes(1);
    expect(mw.inFlight()).toEqual({ total: 0, ips: 0, rooms: 0, members: 0 });
  });

  it("after the 413, stops reading once another upload's worth was read since, and closes before the grace period", () => {
    const { req, finish } = admit();
    req.emit("data", Buffer.alloc(MAX_UPLOAD_BODY_BYTES + 1));
    finish();
    const atAnswer = req.socket.bytesRead;
    req.socket.bytesRead = atAnswer + MAX_UPLOAD_WIRE_BYTES;
    req.emit("data", Buffer.alloc(1));
    expect(req.socket.pause).not.toHaveBeenCalled();
    req.socket.bytesRead++;
    req.emit("data", Buffer.alloc(1));
    req.emit("data", Buffer.alloc(1)); // already parsed when reading stopped
    // The request resumes its socket when read (by multer's pipe too), so it is paused and unpiped as well
    expect(req.socket.pause).toHaveBeenCalledTimes(1);
    expect(req.unpipe).toHaveBeenCalledTimes(1);
    expect(req.pause).toHaveBeenCalledTimes(2); // admission's pause, then this one
    // Not reset at once: the client may not have read the 413 yet
    vi.advanceTimersByTime(OVER_CAP_CLOSE_DELAY_MS - 1);
    expect(req.socket.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(req.socket.destroy).toHaveBeenCalledTimes(1);
    expect(OVER_CAP_CLOSE_DELAY_MS).toBeLessThan(UNREAD_BODY_GRACE_MS);
  });

  it("answers 413 once the bytes read off the connection pass their cap, however little body they carried", () => {
    const { req, res } = admit();
    req.socket.bytesRead = MAX_UPLOAD_WIRE_BYTES + 1; // e.g. 1-byte chunks wrapped in long chunk extensions
    req.emit("data", Buffer.alloc(1));
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ error: "File too large" });
  });

  it("only counts the wire bytes read since this upload's admission (keep-alive connection)", () => {
    const earlier = 10 * MAX_UPLOAD_WIRE_BYTES;
    const { req, res } = admit(earlier);
    req.socket.bytesRead = earlier + MAX_UPLOAD_WIRE_BYTES;
    req.emit("data", Buffer.alloc(1));
    expect(res.body).toBeUndefined();
    req.socket.bytesRead++;
    req.emit("data", Buffer.alloc(1));
    expect(res.statusCode).toBe(413);
  });

  it("past the cap after the upload was answered, only closes the connection (after the grace period)", () => {
    const { req, res, finish } = admit();
    res.json({ url: "/temp/x.jpg" });
    finish();
    req.emit("data", Buffer.alloc(MAX_UPLOAD_BODY_BYTES + 1));
    expect(res.body).toEqual({ url: "/temp/x.jpg" });
    expect(req.socket.end).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(UNREAD_BODY_GRACE_MS);
    expect(req.socket.destroy).toHaveBeenCalledTimes(1);
  });

  it("drains (and keeps counting) a body left unread by an early answer, like Node does by default", () => {
    const { req, finish } = admit();
    finish();
    expect(req.resume).toHaveBeenCalledTimes(1);
  });

  it("doesn't touch a body that was fully received", () => {
    const { req, finish } = admit();
    req.complete = true;
    finish();
    expect(req.resume).not.toHaveBeenCalled();
  });
});

describe("in-flight slot of an admitted upload", () => {
  it("is freed with the response once the body was fully received", () => {
    const { mw, finish, endBody } = admit();
    endBody();
    expect(mw.inFlight().total).toBe(1); // still being processed
    finish();
    expect(mw.inFlight().total).toBe(0);
  });

  it("is freed when the client aborts mid-upload", () => {
    const { mw, req, res } = admit();
    req.socket.destroy();
    res.emit("close");
    expect(mw.inFlight().total).toBe(0);
  });

  it("answered early, is held until the rest of the body arrives, and only then removes its socket listener", () => {
    const { mw, req, res, finish, endBody } = admit();
    res.status(429).json({ error: "Too many uploads" });
    finish();
    expect(mw.inFlight().total).toBe(1);
    endBody();
    expect(mw.inFlight().total).toBe(0);
    expect(req.socket.listenerCount("close")).toBe(0); // the keep-alive connection doesn't keep it
  });

  it("answered early, is held until the connection closes if the body never ends", () => {
    const { mw, req, res, finish } = admit();
    res.status(429).json({ error: "Too many uploads" });
    finish();
    expect(mw.inFlight().total).toBe(1);
    req.socket.destroy();
    expect(mw.inFlight().total).toBe(0);
  });

  it("answered early, keeps its upload timeout: a body still draining then is cut", () => {
    const { mw, req, res, finish } = admit();
    res.status(429).json({ error: "Too many uploads" });
    finish();
    vi.advanceTimersByTime(TIMEOUT_MS - 1);
    expect(req.socket.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(res.statusCode).toBe(429); // already answered: not answered twice
    expect(req.socket.end).toHaveBeenCalledTimes(1);
    expect(mw.inFlight().total).toBe(1);
    vi.advanceTimersByTime(UNREAD_BODY_GRACE_MS);
    expect(req.socket.destroy).toHaveBeenCalledTimes(1);
    expect(mw.inFlight().total).toBe(0);
  });
});
