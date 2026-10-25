import React from "react";
import fs from "fs";
import path from "path";
import TestRenderer, { act } from "react-test-renderer";

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
    eq(field: string, value: unknown) {
      this.filters.push([field, value]);
      return this;
    }
    async exeForMetadata() {
      return photos.filter((p) => this.filters.every(([f, v]) => (p as any)[f] === v));
    }
  }
  class Asset {
    id: string;
    constructor(assetId: string) {
      this.id = assetId;
    }
    async getUri() {
      return `file:///photos/${this.id} copy.jpg`;
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

import { PhotoProvider, usePhotoContext } from "../app/providers/PhotoContext";

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

    expect(uri).toMatch(/^file:\/\/\/photos\/p[12]%20copy\.jpg$/);
    expect(ctx.photoUri).toBe(uri);
    act(() => r.unmount());
  });

  it("app code never calls a legacy method that the main entry stubs out", () => {
    const stubbed = Object.keys(jest.requireActual(LEGACY_STUBS_PATH));
    expect(stubbed).toContain("getAssetsAsync");

    const listSources = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return listSources(p);
        return /\.tsx?$/.test(e.name) ? [p] : [];
      });

    const offenders = listSources(path.join(__dirname, "../app")).flatMap((file) => {
      const src = fs.readFileSync(file, "utf8");
      const ns = src.match(/import \* as (\w+) from ["']expo-media-library["']/)?.[1];
      const named = src.match(/import \{([^}]*)\} from ["']expo-media-library["']/)?.[1] ?? "";
      return stubbed
        .filter((m) => (ns && new RegExp(`\\b${ns}\\.${m}\\b`).test(src)) || new RegExp(`\\b${m}\\b`).test(named))
        .map((m) => `${path.relative(path.join(__dirname, ".."), file)}: ${m}`);
    });
    expect(offenders).toEqual([]);
  });
});
