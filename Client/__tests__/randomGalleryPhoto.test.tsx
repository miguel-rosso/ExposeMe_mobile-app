import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { countPhotos, createRandomPhotoPicker, PhotoAt } from "../app/utils/randomGalleryPhoto";

// EXP-174: a turn must not read the whole gallery to pick one photo. The image count is found once with
// one-row probes and cached; each pick afterwards is a single one-row query at a random offset.

// ── expo-media-library mock: records every query (offset/limit) ──
const mockGallery = { size: 0 };
const mockQueries: { offset: number; limit: number }[] = [];
const mockListeners: (() => void)[] = [];
jest.mock("expo-media-library", () => {
  class Query {
    skip = 0;
    take = Infinity;
    eq() { return this; }
    offset(n: number) { this.skip = n; return this; }
    limit(n: number) { this.take = n; return this; }
    async exeForMetadata() {
      mockQueries.push({ offset: this.skip, limit: this.take });
      const end = Math.min(mockGallery.size, this.skip + this.take);
      const out: { id: string }[] = [];
      for (let i = this.skip; i < end; i++) out.push({ id: `p${i}` });
      return out;
    }
  }
  class Asset {
    id: string;
    constructor(assetId: string) { this.id = assetId; }
    async getUri() { return `file:///photos/${this.id}.jpg`; }
  }
  const granted = { status: "granted", canAskAgain: true, accessPrivileges: "all", granted: true };
  return {
    getPermissionsAsync: async () => granted,
    requestPermissionsAsync: async () => granted,
    addListener: (l: () => void) => {
      mockListeners.push(l);
      return { remove: () => mockListeners.splice(mockListeners.indexOf(l), 1) };
    },
    Query,
    Asset,
    AssetField: { MEDIA_TYPE: "mediaType" },
    MediaType: { IMAGE: "image" },
  };
});

import { PhotoProvider, usePhotoContext } from "../app/providers/PhotoContext";

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());

const galleryOf = (size: { n: number }, calls: number[] = []): PhotoAt => async (offset) => {
  calls.push(offset);
  return offset < size.n ? `p${offset}` : null;
};

describe("countPhotos", () => {
  it.each([0, 1, 2, 3, 7, 8, 9, 1000, 50_000])("counts %i images with O(log n) one-row probes", async (n) => {
    const calls: number[] = [];
    expect(await countPhotos(galleryOf({ n }, calls))).toBe(n);
    expect(calls.length).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(n + 2)) + 2);
  });
});

describe("createRandomPhotoPicker", () => {
  it("after the first pick, each pick is a single one-row query", async () => {
    const calls: number[] = [];
    const picker = createRandomPhotoPicker(galleryOf({ n: 50_000 }, calls));
    await picker.pick();
    calls.length = 0;
    for (let i = 0; i < 20; i++) expect(await picker.pick()).toMatch(/^p\d+$/);
    expect(calls).toHaveLength(20);
  });

  it("a change event during the count is not lost: the stale count is used once, never cached", async () => {
    const size = { n: 8 };
    let picker!: ReturnType<typeof createRandomPhotoPicker>;
    let fired = false;
    const photoAt: PhotoAt = async (offset) => {
      if (!fired && offset > 0) {
        // Gallery grows mid-count; the change event arrives before the count finishes
        fired = true;
        picker.invalidate();
      }
      return offset < size.n ? `p${offset}` : null;
    };
    picker = createRandomPhotoPicker(photoAt, () => 0.99);
    expect(await picker.pick()).toBe("p7"); // count of 8 used for this pick only
    size.n = 16;
    expect(await picker.pick()).toBe("p15"); // recounted, not the stale 8
  });

  it("is uniform over the gallery", async () => {
    const n = 10;
    // Deterministic PRNG (mulberry32) so the test can't flake
    let seed = 0x5eed;
    const mulberry32 = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const picker = createRandomPhotoPicker(galleryOf({ n }), mulberry32);
    const hits = new Map<string, number>();
    const draws = 20_000;
    for (let i = 0; i < draws; i++) {
      const id = (await picker.pick())!;
      hits.set(id, (hits.get(id) ?? 0) + 1);
    }
    expect(hits.size).toBe(n);
    for (const c of hits.values()) expect(Math.abs(c - draws / n)).toBeLessThan((draws / n) * 0.1);
  });

  it("reaches both ends of the gallery", async () => {
    const values = [0, 0.999999];
    const picker = createRandomPhotoPicker(galleryOf({ n: 5 }), () => values.shift() ?? 0);
    expect(await picker.pick()).toBe("p0");
    expect(await picker.pick()).toBe("p4");
  });

  it("empty gallery: null, and it is re-checked next time (not cached)", async () => {
    const size = { n: 0 };
    const picker = createRandomPhotoPicker(galleryOf(size));
    expect(await picker.pick()).toBeNull();
    size.n = 3;
    expect(await picker.pick()).toMatch(/^p[0-2]$/);
  });

  it("a gallery that shrank without a change event is recounted instead of failing", async () => {
    const size = { n: 100 };
    const picker = createRandomPhotoPicker(galleryOf(size), () => 0.99);
    expect(await picker.pick()).toBe("p99");
    size.n = 10;
    expect(await picker.pick()).toBe("p9");
    size.n = 0;
    expect(await picker.pick()).toBeNull();
  });

  it("invalidate() picks up photos added since the count", async () => {
    const size = { n: 1 };
    const picker = createRandomPhotoPicker(galleryOf(size), () => 0.99);
    expect(await picker.pick()).toBe("p0");
    size.n = 4;
    expect(await picker.pick()).toBe("p0"); // cached count
    picker.invalidate();
    expect(await picker.pick()).toBe("p3");
  });
});

describe("PhotoContext game turns (EXP-174)", () => {
  async function setup() {
    let ctx!: ReturnType<typeof usePhotoContext>;
    const Probe = () => { ctx = usePhotoContext(); return null; };
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<PhotoProvider><Probe /></PhotoProvider>); });
    return { get ctx() { return ctx; }, r };
  }

  beforeEach(() => {
    mockQueries.length = 0;
    mockGallery.size = 50_000;
  });

  it("never reads the whole gallery; later turns are one one-row query each", async () => {
    const t = await setup();
    let result: any;
    await act(async () => { result = await t.ctx.pickGamePhoto(); });
    expect(result.uri).toMatch(/^file:\/\/\/photos\/p\d+\.jpg$/);
    expect(mockQueries.every((q) => q.limit === 1)).toBe(true);
    expect(mockQueries.length).toBeLessThanOrEqual(40); // ~2·log2(50k) count probes + the pick

    for (let turn = 0; turn < 5; turn++) {
      mockQueries.length = 0;
      await act(async () => { result = await t.ctx.pickGamePhoto(); });
      expect(result.uri).toMatch(/^file:\/\/\/photos\/p\d+\.jpg$/);
      expect(mockQueries).toHaveLength(1);
      expect(mockQueries[0].limit).toBe(1);
    }
    act(() => t.r.unmount());
  });

  it("a gallery change event drops the cached count", async () => {
    const t = await setup();
    await act(async () => { await t.ctx.pickGamePhoto(); });
    mockGallery.size = 3;
    act(() => mockListeners.forEach((l) => l()));
    mockQueries.length = 0;
    let result: any;
    await act(async () => { result = await t.ctx.pickGamePhoto(); });
    expect(result.uri).toMatch(/^file:\/\/\/photos\/p[0-2]\.jpg$/);
    expect(mockQueries.length).toBeGreaterThan(1); // recounted
    act(() => t.r.unmount());
    expect(mockListeners).toHaveLength(0);
  });

  it("empty gallery reports no-photos", async () => {
    mockGallery.size = 0;
    const t = await setup();
    let result: unknown;
    await act(async () => { result = await t.ctx.pickGamePhoto(); });
    expect(result).toEqual({ error: "no-photos" });
    act(() => t.r.unmount());
  });
});
