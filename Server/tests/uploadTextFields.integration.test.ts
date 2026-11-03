import fs from "fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { useTestServer } from "./socketHarness";

// POST /upload only takes the photo: any other multipart part (a text field, whatever its name, or a part without
// a Content-Disposition) is refused with a 400 JSON (EXP-439), and the server keeps accepting uploads afterwards.

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-upload-fields-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  process.env.UPLOAD_PLAYER_RATE_MAX = "100000";
  return dir;
});

const BOUNDARY = "exposeme-test-boundary";

const harness = useTestServer();
const { newClient, joinAs } = harness;
let auth: Record<string, string> = {};
let jpeg: Buffer;

type Field = [name: string, value: string];

/** Multipart upload with the photo plus `fields`, sent before or after the photo. */
function uploadWith(fields: Field[], fieldsFirst = true) {
  const form = new FormData();
  const appendFields = () => fields.forEach(([name, value]) => form.append(name, value));
  if (fieldsFirst) appendFields();
  form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "p.jpg");
  if (!fieldsFirst) appendFields();
  return fetch(`${harness.url}/upload`, { method: "POST", body: form, headers: auth });
}

/** Hand-built multipart body: the photo plus a part with no Content-Disposition (FormData can't produce one). */
function uploadWithAnonymousPart(anonymousFirst: boolean) {
  const photoPart = Buffer.concat([
    Buffer.from(`Content-Disposition: form-data; name="image"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    jpeg,
  ]);
  const anonymousPart = Buffer.from("Content-Type: text/plain\r\n\r\nhello");
  const parts = anonymousFirst ? [anonymousPart, photoPart] : [photoPart, anonymousPart];
  const body = Buffer.concat([
    ...parts.flatMap((part) => [Buffer.from(`--${BOUNDARY}\r\n`), part, Buffer.from("\r\n")]),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  ]);
  return fetch(`${harness.url}/upload`, {
    method: "POST",
    body: new Uint8Array(body),
    headers: { ...auth, "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` },
  });
}

async function expectInvalidUpload(res: Response) {
  expect(res.status).toBe(400);
  expect(res.headers.get("content-type")).toMatch(/application\/json/);
  expect(await res.json()).toEqual({ error: "Invalid upload" });
}

beforeAll(async () => {
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#246" } }).jpeg().toBuffer();
  const host = await newClient();
  const { room, rejoinToken } = await joinAs(host, null, "uploader");
  auth = { Authorization: `Bearer ${rejoinToken!}`, "X-Game-Code": room!.gameCode };
});

afterAll(() => {
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

describe("POST /upload extra multipart parts (EXP-439)", () => {
  it("accepts the photo alone", async () => {
    expect((await uploadWith([])).status).toBe(200);
  });

  it("refuses a text field, before or after the photo, whatever its name", async () => {
    for (const name of ["note", "a[b]"]) {
      await expectInvalidUpload(await uploadWith([[name, "hi"]], true));
      await expectInvalidUpload(await uploadWith([[name, "hi"]], false));
    }
  });

  it("refuses a part without Content-Disposition, before or after the photo", async () => {
    await expectInvalidUpload(await uploadWithAnonymousPart(true));
    await expectInvalidUpload(await uploadWithAnonymousPart(false));
  });

  it("still accepts uploads after refusing malformed ones", async () => {
    await expectInvalidUpload(await uploadWith([["note", "hi"]]));
    await expectInvalidUpload(await uploadWithAnonymousPart(false));
    expect((await uploadWith([])).status).toBe(200);
  });
});
