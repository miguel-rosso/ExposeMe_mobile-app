import fs from "fs";
import { EventEmitter } from "events";
import { afterAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { Request, Response } from "express";

// EXP-178: every upload admitted by the in-flight caps (middlewares/uploadInFlight) holds its slot through image
// processing, so the sanitize queue must have room for all of them: none may get a 503 from the queue.

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-sanitize-queue-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  process.env.UPLOAD_INFLIGHT_MAX = "40"; // over the old fixed queue (16)
  delete process.env.SANITIZE_QUEUE_TIMEOUT_MS;
  return dir;
});

import { UPLOAD_INFLIGHT_MAX } from "../middlewares/uploadInFlight";
import {
  limit,
  SANITIZE_MAX_CONCURRENT,
  SANITIZE_MAX_QUEUED,
  SANITIZE_QUEUE_TIMEOUT_MS,
  sanitizeImage,
} from "../controllers/sanitizeImage";
import { UploadRouter } from "../controllers/UploadController";

afterAll(() => fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }));

describe("sanitize queue sized from the in-flight caps", () => {
  it("has a place for every upload the server-wide in-flight cap admits", () => {
    expect(SANITIZE_MAX_CONCURRENT + SANITIZE_MAX_QUEUED).toBeGreaterThanOrEqual(UPLOAD_INFLIGHT_MAX);
    // backstop only: a full queue of a few hundred ms per image must fit well within it
    expect(SANITIZE_QUEUE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("processes UPLOAD_INFLIGHT_MAX images submitted at once without refusing any", async () => {
    const img = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#345" } }).jpeg().toBuffer();
    const results = await Promise.allSettled(Array.from({ length: UPLOAD_INFLIGHT_MAX }, () => sanitizeImage(img)));
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toEqual([]);
    expect(limit.stats()).toEqual({ running: 0, queued: 0 });
  });

  it("a client that goes away while its image waits takes its job out of the queue (nothing answered)", async () => {
    const img = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#345" } }).jpeg().toBuffer();
    let finishBusy!: () => void;
    const busy = limit(() => new Promise<void>((r) => { finishBusy = r; })); // holds the only slot until resolved
    const res = Object.assign(new EventEmitter(), {
      headersSent: false,
      writableFinished: false,
      status: vi.fn(),
      json: vi.fn(),
      setHeader: vi.fn(),
    });
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    const req = { file: { buffer: img }, socket: { destroyed: false } };
    const handled = UploadRouter(req as unknown as Request, res as unknown as Response);
    expect(limit.stats()).toEqual({ running: 1, queued: 1 });
    req.socket.destroyed = true;
    res.emit("close"); // client aborted (or 408): uploadInFlight frees its slot on this same event
    await handled;
    expect(limit.stats()).toEqual({ running: 1, queued: 0 });
    expect(res.status).not.toHaveBeenCalled();
    finishBusy();
    await busy;
    expect(limit.stats()).toEqual({ running: 0, queued: 0 });
  });

  // EXP-194: the connection closed before the controller ran, so "close" already fired and won't fire again
  it("a client already gone when the controller runs is never queued (nothing answered)", async () => {
    const img = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#345" } }).jpeg().toBuffer();
    let finishBusy!: () => void;
    const busy = limit(() => new Promise<void>((r) => { finishBusy = r; })); // holds the only slot until resolved
    const res = Object.assign(new EventEmitter(), {
      headersSent: false,
      writableFinished: false,
      status: vi.fn(),
      json: vi.fn(),
      setHeader: vi.fn(),
    });
    const req = { file: { buffer: img }, socket: { destroyed: true } };
    const handled = UploadRouter(req as unknown as Request, res as unknown as Response);
    expect(limit.stats()).toEqual({ running: 1, queued: 0 });
    await handled;
    expect(res.status).not.toHaveBeenCalled();
    finishBusy();
    await busy;
  });
});
