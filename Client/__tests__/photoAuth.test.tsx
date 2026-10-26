import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Image, Platform } from "react-native";
import { photoAuthHeaders, resolvePhotoAuth } from "../app/utils/photoAuth";
import { getImageSource } from "../app/utils/image";
import PhotoComponent from "../app/components/PhotoComponent";

// EXP-069: the server only serves a room's photos to its members, so the app sends the room code and the player's
// rejoin token as headers on POST /upload and on every in-game <Image> of a server photo.

jest.mock("expo-blur", () => ({ BlurView: () => null }));
// The test renderer can't measure views: one blurred element measured at a fixed rect, so ImageBlurShape draws its
// blur shape image
const mockBlurRefs = [{ current: { measureLayout: (_rel: unknown, cb: (x: number, y: number, w: number, h: number) => void) => cb(0, 0, 300, 600) } }];
jest.mock("../app/hooks/useImageBlur", () => () => ({
  getRefList: () => mockBlurRefs, getBlurProps: () => undefined, pushRef: () => {}, setBlurProps: () => {},
}));

const AUTH = { gameCode: "123456", token: "tok-123" };
const HEADERS = { Authorization: "Bearer tok-123", "X-Game-Code": "123456" };

describe("photoAuth", () => {
  it("builds the bearer + room code headers", () => {
    expect(photoAuthHeaders(AUTH)).toEqual(HEADERS);
  });

  it("resolves the stored rejoin token for the current game", async () => {
    const get = jest.fn(async () => "tok-123");
    await expect(resolvePhotoAuth(get, "123456", "bob")).resolves.toEqual(AUTH);
    expect(get).toHaveBeenCalledWith("123456", "bob");
  });

  it("fails (upload counts as failed) without a session token", async () => {
    await expect(resolvePhotoAuth(async () => null, "123456", "bob")).rejects.toThrow("Upload failed");
    await expect(resolvePhotoAuth(async () => "t", null, "bob")).rejects.toThrow("Upload failed");
  });

  it("getImageSource adds headers only when given", () => {
    expect(getImageSource("http://s/temp/a.jpg")).toEqual({ uri: "http://s/temp/a.jpg" });
    expect(getImageSource("http://s/temp/a.jpg", HEADERS)).toEqual({ uri: "http://s/temp/a.jpg", headers: HEADERS });
    expect(getImageSource(42)).toBe(42);
  });
});

describe("PhotoComponent", () => {
  const sources = (r: TestRenderer.ReactTestRenderer) =>
    r.root.findAll((n) => n.type === Image || (n.props.source && typeof n.type !== "string"), { deep: true }).map((n) => n.props.source);

  it("loads a server photo with the auth headers", async () => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<PhotoComponent photoUrl="http://s/temp/a.jpg" headers={HEADERS} />); });
    const srcs = sources(r).filter(Boolean);
    expect(srcs.length).toBeGreaterThan(0);
    for (const s of srcs) expect(s).toEqual({ uri: "http://s/temp/a.jpg", headers: HEADERS });
  });

  it("loads a local photo without headers", async () => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<PhotoComponent photoUrl="file:///DCIM/a.jpg" />); });
    for (const s of sources(r).filter(Boolean)) expect(s).toEqual({ uri: "file:///DCIM/a.jpg" });
  });

  describe("on Android (blurred backdrop image)", () => {
    const originalOS = Platform.OS;
    beforeAll(() => Object.defineProperty(Platform, "OS", { configurable: true, get: () => "android" }));
    afterAll(() => Object.defineProperty(Platform, "OS", { configurable: true, get: () => originalOS }));

    it("every Image of a server photo carries the auth headers", async () => {
      let r!: TestRenderer.ReactTestRenderer;
      await act(async () => { r = TestRenderer.create(<PhotoComponent photoUrl="http://s/temp/a.jpg" headers={HEADERS} />); });
      const images = r.root.findAll((n) => n.type === Image);
      // Blurred backdrop and main photo, both drawn on mount (EXP-225: no layout round trip)
      expect(images).toHaveLength(2);
      expect(images.filter((img) => img.props.blurRadius > 0)).toHaveLength(1);
      for (const img of images) expect(img.props.source).toEqual({ uri: "http://s/temp/a.jpg", headers: HEADERS });
      const animated = r.root.findAll((n) => n.props.source && typeof n.type !== "string" && n.type !== Image);
      for (const n of animated) expect(n.props.source).toEqual({ uri: "http://s/temp/a.jpg", headers: HEADERS });
    });
  });
});
