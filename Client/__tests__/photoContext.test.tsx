import React from "react";
import fs from "fs";
import path from "path";
import TestRenderer, { act } from "react-test-renderer";
import { clientRelative, listAppSources } from "../testUtils/appSources";

// Real SDK 58 stubs: every legacy method imported from the "expo-media-library" entry throws at runtime
const LEGACY_STUBS_PATH = path.join(__dirname, "../node_modules/expo-media-library/build/legacyWarnings");

jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn() }) }));

jest.mock("expo-media-library", () => {
  const photos = [
    { id: "p1", mediaType: "image" },
    { id: "p2", mediaType: "image" },
  ];
  class Query {
    filters: [string, unknown][] = [];
    skip = 0;
    take = Infinity;
    eq(field: string, value: unknown) {
      this.filters.push([field, value]);
      return this;
    }
    offset(n: number) {
      this.skip = n;
      return this;
    }
    limit(n: number) {
      this.take = n;
      return this;
    }
    async exeForMetadata() {
      return photos.filter((p) => this.filters.every(([f, v]) => (p as any)[f] === v)).slice(this.skip, this.skip + this.take);
    }
  }
  class Asset {
    id: string;
    constructor(assetId: string) {
      this.id = assetId;
    }
    // Like the native module: Android builds it with Uri.fromFile and iOS with URL.absoluteString, so a path with a
    // space or an accent arrives already percent-encoded
    async getUri() {
      return `file:///storage/emulated/0/Pictures/WhatsApp%20Images/${this.id}%20a%C3%B1o.jpg`;
    }
  }
  return {
    ...jest.requireActual(require("path").join(__dirname, "../node_modules/expo-media-library/build/legacyWarnings")),
    requestPermissionsAsync: jest.fn(async () => ({ status: "granted", canAskAgain: true, accessPrivileges: "all" })),
    getPermissionsAsync: jest.fn(async () => ({ status: "granted", canAskAgain: true, accessPrivileges: "all" })),
    Query,
    Asset,
    AssetField: { MEDIA_TYPE: "mediaType" },
    MediaType: { IMAGE: "image" },
  };
});

import { PhotoProvider, usePhotoContext } from "../src/providers/PhotoContext";

describe("PhotoContext with expo-media-library SDK 58 (EXP-038)", () => {
  it("picks a random gallery photo through the class-based API", async () => {
    let ctx!: ReturnType<typeof usePhotoContext>;
    const Probe = () => {
      ctx = usePhotoContext();
      return null;
    };
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(
        <PhotoProvider>
          <Probe />
        </PhotoProvider>
      );
    });

    let uri: string | null = null;
    await act(async () => {
      uri = await ctx.getRandomPhoto();
    });

    expect(uri).toMatch(/^file:\/\/\/storage\/emulated\/0\/Pictures\/WhatsApp%20Images\/p[12]%20a%C3%B1o\.jpg$/);
    expect(ctx.photoUri).toBe(uri);
  });

  it("keeps the photo URI exactly as the gallery returns it: encoding it again points at a file that doesn't exist", async () => {
    let ctx!: ReturnType<typeof usePhotoContext>;
    const Probe = () => {
      ctx = usePhotoContext();
      return null;
    };
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(
        <PhotoProvider>
          <Probe />
        </PhotoProvider>
      );
    });

    const uris: (string | null)[] = [];
    await act(async () => {
      uris.push(await ctx.getRandomPhoto());
    });
    let game: Awaited<ReturnType<typeof ctx.pickGamePhoto>> | null = null;
    await act(async () => {
      game = await ctx.pickGamePhoto();
    });
    uris.push(game && "uri" in game ? (game as { uri: string }).uri : null);

    for (const uri of uris) {
      expect(uri).not.toBeNull();
      expect(uri).not.toContain("%25");
      expect(decodeURI(uri!)).toMatch(/\/WhatsApp Images\/p[12] año\.jpg$/);
    }
    act(() => r.unmount());
    act(() => r.unmount());
  });

  it("app code never calls a legacy method that the main entry stubs out", () => {
    const stubbed = Object.keys(jest.requireActual(LEGACY_STUBS_PATH));
    expect(stubbed).toContain("getAssetsAsync");

    const offenders = listAppSources().flatMap((file) => {
      const src = fs.readFileSync(file, "utf8");
      const ns = src.match(/import \* as (\w+) from ["']expo-media-library["']/)?.[1];
      const named = src.match(/import \{([^}]*)\} from ["']expo-media-library["']/)?.[1] ?? "";
      return stubbed
        .filter((m) => (ns && new RegExp(`\\b${ns}\\.${m}\\b`).test(src)) || new RegExp(`\\b${m}\\b`).test(named))
        .map((m) => `${clientRelative(file)}: ${m}`);
    });
    expect(offenders).toEqual([]);
  });
});
