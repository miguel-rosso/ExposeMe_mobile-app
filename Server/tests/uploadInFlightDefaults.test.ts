import fs from "fs";
import { afterAll, describe, expect, it, vi } from "vitest";

// EXP-165: default /upload concurrency caps. A full party (12 players) shares one public IP and one room.

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-upload-inflight-defaults-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  for (const name of [
    "UPLOAD_INFLIGHT_MAX",
    "UPLOAD_INFLIGHT_PER_IP_MAX",
    "UPLOAD_INFLIGHT_PER_IP_BUSY_MAX",
    "UPLOAD_INFLIGHT_PER_ROOM_MAX",
    "UPLOAD_INFLIGHT_PER_MEMBER_MAX",
    "UPLOAD_REQUEST_TIMEOUT_MS",
  ]) delete process.env[name];
  return dir;
});

import * as caps from "../middlewares/uploadInFlight";

afterAll(() => fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }));

describe("default upload concurrency caps", () => {
  it("fit a full party on one IP and room, 2 per member, 32 server-wide, 20 s to receive the body", () => {
    expect(caps.UPLOAD_INFLIGHT_PER_IP_MAX).toBe(12);
    expect(caps.UPLOAD_INFLIGHT_PER_ROOM_MAX).toBe(12);
    expect(caps.UPLOAD_INFLIGHT_PER_MEMBER_MAX).toBe(2);
    expect(caps.UPLOAD_INFLIGHT_MAX).toBe(32);
    expect(caps.UPLOAD_REQUEST_TIMEOUT_MS).toBe(20_000);
  });

  it("EXP-261: hold each IP to 4 once half the server-wide slots are taken", () => {
    expect(caps.UPLOAD_INFLIGHT_PER_IP_BUSY_MAX).toBe(4);
    expect(caps.UPLOAD_INFLIGHT_BUSY_SHARE).toBe(0.5);
  });
});
