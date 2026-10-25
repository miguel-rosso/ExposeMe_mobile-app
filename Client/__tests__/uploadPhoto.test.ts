import { uploadPhoto, uploadFileMeta } from "../app/utils/uploadPhoto";

// expo-file-system File: name/extension come from the URI, type is the MIME ("" when unknown)
jest.mock("expo-file-system", () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get extension() {
      const m = decodeURI(this.uri).match(/(\.[^./]+)$/);
      return m ? m[1] : "";
    }
    get type() {
      return "";
    }
    async bytes() {
      return new Uint8Array([1, 2, 3]);
    }
  },
}));

// Path check applied by Server/routes/socketRoutes.ts to photo-sent / plant-photo URLs
const SERVER_UPLOAD_PATH_RE = /^\/temp\/\d+-[A-Za-z0-9._-]+$/;

type Part = [string, { name: string; type: string; bytes: () => Promise<Uint8Array> }];
let parts: Part[];
class FakeFormData {
  append(field: string, value: any) {
    parts.push([field, value]);
  }
}

const okResponse = (url: string) => ({ ok: true, status: 200, json: async () => ({ url }) });

beforeEach(() => {
  parts = [];
  (global as any).FormData = FakeFormData;
  (global as any).fetch = jest.fn(async () => okResponse("/temp/1761000000000-photo.jpg"));
});

describe("uploadPhoto (EXP-038)", () => {
  it.each([
    ["file:///DCIM/p1%20copy.jpg", "photo.jpg", "image/jpeg"],
    ["file:///DCIM/Caf%C3%A9.HEIC", "photo.heic", "image/heic"],
    ["file:///DCIM/IMG_1234%20(1).PNG", "photo.png", "image/png"],
    ["file:///cache/no-extension", "photo.jpg", "image/jpeg"],
    // Privacy: nothing of the original name (source app, capture time, device) may leak
    ["file:///Pictures/Screenshot_20261024-231502_Bank%20Santander.jpg", "photo.jpg", "image/jpeg"],
    ["file:///DCIM/PXL_20261024_231502123.jpg", "photo.jpg", "image/jpeg"],
  ])("sends %s as a neutral, server-safe filename", async (uri, name, type) => {
    const url = await uploadPhoto("http://server", uri);

    expect(url).toBe("/temp/1761000000000-photo.jpg");
    expect(fetch).toHaveBeenCalledWith("http://server/upload", expect.objectContaining({ method: "POST" }));
    expect(parts).toHaveLength(1);
    const [field, part] = parts[0];
    expect(field).toBe("image");
    expect(part.name).toBe(name);
    expect(part.type).toBe(type);
    expect(`/temp/${Date.now()}-${part.name}`).toMatch(SERVER_UPLOAD_PATH_RE);
    await expect(part.bytes()).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it("throws when the server answers non-200", async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 413, json: async () => ({}) }));
    await expect(uploadPhoto("http://server", "file:///DCIM/a.jpg")).rejects.toThrow("Upload failed: 413");
  });

  it("falls back to the MIME type when the extension is not an image one", () => {
    expect(uploadFileMeta(".bin", "image/webp")).toEqual({ name: "photo.webp", type: "image/webp" });
    expect(uploadFileMeta("", "")).toEqual({ name: "photo.jpg", type: "image/jpeg" });
  });
});

describe("uploadPhoto with expo/fetch's real multipart serializer", () => {
  it("serializes the wrapped file part with the safe filename, MIME and bytes", async () => {
    const RNFormData = jest.requireActual("react-native/Libraries/Network/FormData").default;
    const { installFormDataPatch } = jest.requireActual("expo/src/winter/FormData");
    const { convertFormDataAsync } = jest.requireActual("expo/src/winter/fetch/convertFormData");
    installFormDataPatch(RNFormData);
    (global as any).FormData = RNFormData;
    let sent: unknown;
    (global as any).fetch = jest.fn(async (_url: string, init: { body: unknown }) => {
      sent = init.body;
      return okResponse("/temp/1761000000000-photo.jpg");
    });

    await uploadPhoto("http://server", "file:///Pictures/Screenshot_20261024-231502_Bank%20Santander.jpg");

    const { body } = await convertFormDataAsync(sent, "BOUNDARY");
    const text = new TextDecoder().decode(body);
    expect(text).toContain('content-disposition: form-data; name="image"; filename="photo.jpg"');
    expect(text).toContain("content-type: image/jpeg");
    expect(text).not.toMatch(/Screenshot|Santander|20261024/);
    expect(Array.from(body as Uint8Array)).toEqual(expect.arrayContaining([1, 2, 3]));
  });
});
