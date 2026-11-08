import { EventEmitter } from "events";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createInFlightLimiter, MAX_UPLOAD_BODY_BYTES, MAX_UPLOAD_WIRE_BYTES } from "../middlewares/uploadInFlight";

// EXP-442: the in-flight limiter counts an admitted upload's body bytes as they are read, without starting to read
// the body itself, and aborts the upload with 413 once they pass MAX_UPLOAD_BODY_BYTES, or once the bytes read off
// the connection since admission pass MAX_UPLOAD_WIRE_BYTES.

const limiter = () => createInFlightLimiter({ max: 10, perIpMax: 10, perRoomMax: 10, perMemberMax: 10, timeoutMs: 60_000 });

/** Admits an upload on a connection that has already read `wireBefore` bytes (its head, earlier keep-alive requests). */
function admit(wireBefore = 0) {
  const req = Object.assign(new EventEmitter(), {
    ip: "198.51.100.9",
    complete: false,
    socket: { destroy: vi.fn(), bytesRead: wireBefore },
    pause: vi.fn(),
    resume: vi.fn(),
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
  return { mw, req, res };
}

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
    expect(req.socket.destroy).not.toHaveBeenCalled();
  });

  it("answers 413 past the cap and closes the connection once the response is out, freeing the slot", () => {
    const { mw, req, res } = admit();
    req.emit("data", Buffer.alloc(MAX_UPLOAD_BODY_BYTES));
    req.emit("data", Buffer.alloc(1));
    expect(res.statusCode).toBe(413);
    expect(res.headers.Connection).toBe("close");
    expect(res.body).toEqual({ error: "File too large" });
    expect(req.socket.destroy).not.toHaveBeenCalled();
    res.emit("finish");
    expect(req.socket.destroy).toHaveBeenCalledTimes(1);
    expect(mw.inFlight().total).toBe(0);
    req.emit("data", Buffer.alloc(1)); // bytes still arriving don't answer twice
    expect(req.socket.destroy).toHaveBeenCalledTimes(1);
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

  it("past the cap after the upload was answered, only closes the connection", () => {
    const { req, res } = admit();
    res.json({ url: "/temp/x.jpg" });
    res.writableFinished = true;
    req.emit("data", Buffer.alloc(MAX_UPLOAD_BODY_BYTES + 1));
    expect(res.body).toEqual({ url: "/temp/x.jpg" });
    expect(req.socket.destroy).toHaveBeenCalledTimes(1);
  });

  it("drains (and keeps counting) a body left unread by an early answer, like Node does by default", () => {
    const { req, res } = admit();
    res.emit("finish");
    expect(req.resume).toHaveBeenCalledTimes(1);
  });

  it("doesn't touch a body that was fully received", () => {
    const { req, res } = admit();
    req.complete = true;
    res.emit("finish");
    expect(req.resume).not.toHaveBeenCalled();
  });
});
