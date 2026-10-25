import { uploadPhoto, UPLOAD_MAX_SIDE, UPLOAD_JPEG_QUALITY } from "../app/utils/uploadPhoto";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

// expo-image-manipulator: manipulate(uri, loadOptions) -> context.renderAsync() -> image.saveAsync()
const mockSaveAsync = jest.fn();
const mockRenderAsync = jest.fn();
const mockContextRelease = jest.fn();
const mockImageRelease = jest.fn();
jest.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg", PNG: "png", WEBP: "webp" },
  ImageManipulator: { manipulate: jest.fn() },
}));
const manipulate = ImageManipulator.manipulate as jest.Mock;
const CONVERTED_URI = "file:///cache/ImageManipulator/9F1C-converted.jpg";

// expo-file-system File: name/extension come from the URI, type is the MIME ("" when unknown)
const mockDeleted: string[] = [];
const mockReadFrom: string[] = [];
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
      mockReadFrom.push(this.uri);
      return new Uint8Array([1, 2, 3]);
    }
    delete() {
      mockDeleted.push(this.uri);
    }
  },
}));

// Path check applied by Server/routes/socketRoutes.ts to photo-sent / plant-photo URLs
const SERVER_UPLOAD_PATH_RE = /^\/temp\/[0-9a-f]{32}\.(?:jpg|png|webp)$/;
const SERVER_PHOTO = "/temp/" + "0123456789abcdef".repeat(2) + ".jpg";

type Part = [string, { name: string; type: string; bytes: () => Promise<Uint8Array> }];
let parts: Part[];
class FakeFormData {
  append(field: string, value: any) {
    parts.push([field, value]);
  }
}

const AUTH = { gameCode: "123456", token: "tok-123" };

const okResponse = (url: string) => ({ ok: true, status: 200, json: async () => ({ url }) });

beforeEach(() => {
  parts = [];
  mockDeleted.length = 0;
  mockReadFrom.length = 0;
  jest.clearAllMocks();
  mockSaveAsync.mockResolvedValue({ uri: CONVERTED_URI, width: 1600, height: 1200 });
  mockRenderAsync.mockResolvedValue({ width: 1600, height: 1200, saveAsync: mockSaveAsync, release: mockImageRelease });
  manipulate.mockReturnValue({ renderAsync: mockRenderAsync, release: mockContextRelease });
  (global as any).FormData = FakeFormData;
  (global as any).fetch = jest.fn(async () => okResponse(SERVER_PHOTO));
});

describe("uploadPhoto (EXP-038)", () => {
  it.each([
    ["file:///DCIM/p1%20copy.jpg", "photo.jpg", "image/jpeg"],
    ["file:///DCIM/Caf%C3%A9.HEIC", "photo.jpg", "image/jpeg"],
    ["file:///DCIM/IMG_1234%20(1).PNG", "photo.jpg", "image/jpeg"],
    ["file:///cache/no-extension", "photo.jpg", "image/jpeg"],
    // Privacy: nothing of the original name (source app, capture time, device) may leak
    ["file:///Pictures/Screenshot_20261024-231502_Bank%20Santander.jpg", "photo.jpg", "image/jpeg"],
    ["file:///DCIM/PXL_20261024_231502123.jpg", "photo.jpg", "image/jpeg"],
  ])("sends %s as a neutral, server-safe filename", async (uri, name, type) => {
    const url = await uploadPhoto("http://server", uri, AUTH);

    expect(url).toBe(SERVER_PHOTO);
    expect(fetch).toHaveBeenCalledWith("http://server/upload", expect.objectContaining({ method: "POST" }));
    expect(parts).toHaveLength(1);
    const [field, part] = parts[0];
    expect(field).toBe("image");
    expect(part.name).toBe(name);
    expect(part.type).toBe(type);
    expect(url).toMatch(SERVER_UPLOAD_PATH_RE);
    await expect(part.bytes()).resolves.toEqual(new Uint8Array([1, 2, 3]));
    // The converted copy is uploaded, never the original
    expect(mockReadFrom).toEqual([CONVERTED_URI]);
  });

  it("throws when the server answers non-200", async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 413, json: async () => ({}) }));
    await expect(uploadPhoto("http://server", "file:///DCIM/a.jpg", AUTH)).rejects.toThrow("Upload failed: 413");
  });

  // EXP-069: uploads are only accepted from a member of the room, identified by room code + rejoin token
  it("sends the room code and the player's rejoin token as headers, never in the URL", async () => {
    await uploadPhoto("http://server", "file:///DCIM/a.jpg", AUTH);
    const [calledUrl, init] = (fetch as jest.Mock).mock.calls[0];
    expect(calledUrl).toBe("http://server/upload");
    expect(init.headers).toEqual({ Authorization: "Bearer tok-123", "X-Game-Code": "123456" });
  });

  it("surfaces 401/403 (not a member / not my turn) as a failed upload", async () => {
    for (const status of [401, 403]) {
      (global as any).fetch = jest.fn(async () => ({ ok: false, status, json: async () => ({ error: "x" }) }));
      await expect(uploadPhoto("http://server", "file:///DCIM/a.jpg", AUTH)).rejects.toThrow(`Upload failed: ${status}`);
    }
  });
});

describe("uploadPhoto converts before uploading (EXP-007)", () => {
  it.each([
    ["HEIC from an iPhone", "file:///DCIM/IMG_0001.HEIC"],
    ["PNG screenshot", "file:///Pictures/Screenshot.png"],
    ["large 12 MP JPEG", "file:///DCIM/PXL_4032x3024.jpg"],
    ["WebP", "file:///Download/a.webp"],
  ])("re-encodes a %s as a bounded JPEG", async (_label, uri) => {
    await uploadPhoto("http://server", uri, AUTH);

    expect(manipulate).toHaveBeenCalledTimes(1);
    expect(manipulate).toHaveBeenCalledWith(uri, { maxWidth: UPLOAD_MAX_SIDE, maxHeight: UPLOAD_MAX_SIDE });
    expect(mockSaveAsync).toHaveBeenCalledWith({ format: SaveFormat.JPEG, compress: UPLOAD_JPEG_QUALITY });
    // No EXIF/base64 extras requested
    expect(mockSaveAsync.mock.calls[0][0]).not.toHaveProperty("base64");
    const [, part] = parts[0];
    expect(part.name).toBe("photo.jpg");
    expect(part.type).toBe("image/jpeg");
  });

  it("bounds the longest side to a full-screen phone size and uses ~0.8 quality", () => {
    expect(UPLOAD_MAX_SIDE).toBeGreaterThanOrEqual(1600);
    expect(UPLOAD_MAX_SIDE).toBeLessThanOrEqual(2048);
    expect(UPLOAD_JPEG_QUALITY).toBeCloseTo(0.8);
  });

  it("releases native refs and deletes the converted copy after uploading", async () => {
    await uploadPhoto("http://server", "file:///DCIM/a.heic", AUTH);
    expect(mockImageRelease).toHaveBeenCalled();
    expect(mockContextRelease).toHaveBeenCalled();
    expect(mockDeleted).toEqual([CONVERTED_URI]);
  });

  it("deletes the converted copy even when the upload fails", async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(uploadPhoto("http://server", "file:///DCIM/a.heic", AUTH)).rejects.toThrow("Upload failed: 500");
    expect(mockDeleted).toEqual([CONVERTED_URI]);
  });

  it("throws a clear error and uploads nothing when the conversion fails", async () => {
    mockRenderAsync.mockRejectedValue(new Error("Could not decode image"));
    await expect(uploadPhoto("http://server", "file:///DCIM/broken.heic", AUTH)).rejects.toThrow(
      "Photo conversion failed: Could not decode image",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(mockContextRelease).toHaveBeenCalled();
  });

  it("throws a clear error when saving the JPEG fails", async () => {
    mockSaveAsync.mockRejectedValue(new Error("disk full"));
    await expect(uploadPhoto("http://server", "file:///DCIM/a.png", AUTH)).rejects.toThrow("Photo conversion failed: disk full");
    expect(fetch).not.toHaveBeenCalled();
    expect(mockImageRelease).toHaveBeenCalled();
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
      return okResponse(SERVER_PHOTO);
    });

    await uploadPhoto("http://server", "file:///Pictures/Screenshot_20261024-231502_Bank%20Santander.jpg", AUTH);

    const { body } = await convertFormDataAsync(sent, "BOUNDARY");
    const text = new TextDecoder().decode(body);
    expect(text).toContain('content-disposition: form-data; name="image"; filename="photo.jpg"');
    expect(text).toContain("content-type: image/jpeg");
    expect(text).not.toMatch(/Screenshot|Santander|20261024/);
    expect(Array.from(body as Uint8Array)).toEqual(expect.arrayContaining([1, 2, 3]));
  });
});
