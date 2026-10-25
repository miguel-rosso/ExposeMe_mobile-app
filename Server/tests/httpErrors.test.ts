import fs from "fs";
import { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { io, server } from "../app";
import { setUploadRooms } from "../middlewares/uploadAccess";
import type { Player, Room } from "../models/interfaces";

// Final HTTP error handling: whatever goes wrong (bad URL encoding, body parse errors, a failing disk write)
// the client gets a short JSON error, never Express' default HTML page with a stack trace and server paths.

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-http-errors-test-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  return dir;
});

let url: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve) => io.close(() => resolve()));
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

async function expectSafeJson(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toMatch(/application\/json/);
  const text = await res.text();
  expect(text).not.toMatch(/<html|<pre>|node_modules|\bat .*\.(?:ts|js):\d|\/Users\/|\/home\/|Error:/i);
  const body = JSON.parse(text);
  expect(Object.keys(body)).toEqual(["error"]);
  expect(typeof body.error).toBe("string");
  return body;
}

describe("final error handler", () => {
  it.each(["/temp/%E0%A4%A", "/join/%ZZ", "/temp/%"])("malformed percent-encoding %s → 400 JSON, no trace", async (p) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expectSafeJson(await fetch(`${url}${p}`), 400);
  });

  it("malformed JSON body → 400 JSON, no trace", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fetch(`${url}/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    await expectSafeJson(res, 400);
  });

  it("oversized JSON body → 413 JSON", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fetch(`${url}/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: "a".repeat(200_000) }),
    });
    await expectSafeJson(res, 413);
  });

  it("disk write failure while saving an upload → 500 JSON without details, error logged server-side", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const diskErr = Object.assign(new Error(`ENOSPC: no space left on device, open '${UPLOAD_DIR}/x.jpg'`), { code: "ENOSPC" });
    vi.spyOn(fs.promises, "writeFile").mockRejectedValueOnce(diskErr);

    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#123" } }).jpeg().toBuffer();
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "a.jpg");
    // Uploads need a room member (uploadAccess): a fake lobby room
    const player = { username: "ann", rejoinToken: "tok" } as Player;
    const room = { gameCode: "123456", phase: null, players: [player], currentPlayer: null } as unknown as Room;
    setUploadRooms({ getRoom: () => room, authenticate: () => ({ room, player }) });
    const res = await fetch(`${url}/upload`, { method: "POST", body: form, headers: { Authorization: "Bearer tok", "X-Game-Code": "123456" } });
    setUploadRooms(null);

    const body = await expectSafeJson(res, 500);
    expect(body.error).not.toMatch(/ENOSPC|exposeme/i);
    expect(errorLog).toHaveBeenCalled();
    expect(errorLog.mock.calls.flat().some((a) => a === diskErr || String(a).includes("ENOSPC"))).toBe(true);
  });

  it("unknown routes still answer 404", async () => {
    const res = await fetch(`${url}/nope`);
    expect(res.status).toBe(404);
  });
});
