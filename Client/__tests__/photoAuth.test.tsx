import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Image, Platform } from "react-native";
import { photoAuthHeaders, resolvePhotoAuth } from "../src/utils/photoAuth";
import { getImageSource } from "../src/utils/image";
import PhotoComponent from "../src/components/PhotoComponent";
import { FakeXhr, installFakeXhr } from "../testUtils/fakeXhr";

// EXP-069: the server only serves a room's photos to its members, so the app sends the room code and the player's
// rejoin token as headers on POST /upload and on every in-game <Image> of a server photo.

jest.mock("expo-blur", () => ({ BlurView: () => null }));

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

  it("on iOS downloads a server photo with the auth headers (once, for every view: EXP-394)", async () => {
    const restoreXhr = installFakeXhr();
    try {
      await act(async () => { TestRenderer.create(<PhotoComponent photoUrl="http://s/temp/a.jpg" headers={HEADERS} />); });
      expect(FakeXhr.requests).toHaveLength(1);
      expect(FakeXhr.requests[0]).toMatchObject({ url: "http://s/temp/a.jpg", headers: HEADERS });
    } finally {
      restoreXhr();
    }
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
      // The blurred backdrop is drawn once the main photo has loaded (EXP-131)
      const main = r.root.find((n) => typeof n.props.onLoad === "function" && typeof n.type !== "string");
      act(() => main.props.onLoad());
      const images = r.root.findAll((n) => n.type === Image);
      expect(images).toHaveLength(2);
      expect(images.filter((img) => img.props.blurRadius > 0)).toHaveLength(1);
      for (const img of images) expect(img.props.source).toEqual({ uri: "http://s/temp/a.jpg", headers: HEADERS });
      const animated = r.root.findAll((n) => n.props.source && typeof n.type !== "string" && n.type !== Image);
      for (const n of animated) expect(n.props.source).toEqual({ uri: "http://s/temp/a.jpg", headers: HEADERS });
    });
  });
});
