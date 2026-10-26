import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// EXP-041: picking the photo for your-turn must never navigate (that unmounts the game screen and drops the
// player from the game). Limited access uses the photos it can see; no access / no photos are reported.

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: mockReplace }) }));

const mockPhotos: { id: string; mediaType: string }[] = [];
const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
jest.mock("expo-media-library", () => {
  class Query {
    skip = 0;
    take = Infinity;
    eq() { return this; }
    offset(n: number) { this.skip = n; return this; }
    limit(n: number) { this.take = n; return this; }
    async exeForMetadata() { return mockPhotos.slice(this.skip, this.skip + this.take); }
  }
  class Asset {
    id: string;
    constructor(assetId: string) { this.id = assetId; }
    async getUri() { return `file:///photos/${this.id}.jpg`; }
  }
  return {
    getPermissionsAsync: (...a: unknown[]) => mockGetPermissions(...a),
    requestPermissionsAsync: (...a: unknown[]) => mockRequestPermissions(...a),
    Query,
    Asset,
    AssetField: { MEDIA_TYPE: "mediaType" },
    MediaType: { IMAGE: "image" },
  };
});

import { PhotoProvider, usePhotoContext } from "../app/providers/PhotoContext";

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());

const perm = (status: string, accessPrivileges: string, canAskAgain = true) => ({ status, accessPrivileges, canAskAgain, granted: status === "granted" });

async function setup() {
  let ctx!: ReturnType<typeof usePhotoContext>;
  const Probe = () => { ctx = usePhotoContext(); return null; };
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<PhotoProvider><Probe /></PhotoProvider>); });
  return { get ctx() { return ctx; }, r };
}

describe("pickGamePhoto (in-game, EXP-041)", () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockGetPermissions.mockReset();
    mockRequestPermissions.mockReset();
    mockPhotos.length = 0;
  });

  it("limited access with selected photos: picks one of them and stays on the game screen", async () => {
    mockGetPermissions.mockResolvedValue(perm("granted", "limited"));
    mockPhotos.push({ id: "p1", mediaType: "image" });
    const t = await setup();
    let result: unknown;
    await act(async () => { result = await t.ctx.pickGamePhoto(); });
    expect(result).toEqual({ uri: "file:///photos/p1.jpg" });
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockRequestPermissions).not.toHaveBeenCalled();
    act(() => t.r.unmount());
  });

  it("limited access with nothing selected: reports no-photos, no navigation", async () => {
    mockGetPermissions.mockResolvedValue(perm("granted", "limited"));
    const t = await setup();
    let result: unknown;
    await act(async () => { result = await t.ctx.pickGamePhoto(); });
    expect(result).toEqual({ error: "no-photos" });
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => t.r.unmount());
  });

  it("denied: reports permission without prompting or navigating", async () => {
    mockGetPermissions.mockResolvedValue(perm("denied", "none", false));
    mockPhotos.push({ id: "p1", mediaType: "image" });
    const t = await setup();
    let result: unknown;
    await act(async () => { result = await t.ctx.pickGamePhoto(); });
    expect(result).toEqual({ error: "permission" });
    expect(mockRequestPermissions).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => t.r.unmount());
  });

  it("never decided: asks once in place, then uses the answer", async () => {
    mockGetPermissions.mockResolvedValue(perm("undetermined", "none"));
    mockRequestPermissions.mockResolvedValue(perm("denied", "none", false));
    const t = await setup();
    let result: unknown;
    await act(async () => { result = await t.ctx.pickGamePhoto(); });
    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ error: "permission" });
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => t.r.unmount());
  });

  it("a gallery error is reported as failed instead of throwing", async () => {
    mockGetPermissions.mockRejectedValue(new Error("boom"));
    const t = await setup();
    let result: unknown;
    await act(async () => { result = await t.ctx.pickGamePhoto(); });
    expect(result).toEqual({ error: "failed" });
    act(() => t.r.unmount());
  });

  it("full access: a random photo", async () => {
    mockGetPermissions.mockResolvedValue(perm("granted", "all"));
    mockPhotos.push({ id: "p1", mediaType: "image" }, { id: "p2", mediaType: "image" });
    const t = await setup();
    let result: any;
    await act(async () => { result = await t.ctx.pickGamePhoto(); });
    expect(result.uri).toMatch(/^file:\/\/\/photos\/p[12]\.jpg$/);
    act(() => t.r.unmount());
  });
});
