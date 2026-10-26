import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// EXP-035 / EXP-126: the photo picked to plant belongs to one game. plantPhoto uploads it and sends plant-photo at
// once (from the lobby, so im-ready never waits for it); it is dropped by "Play again" (which keeps the socket,
// EXP-172) and whenever the game socket ends (exit, leaving, kicked), so the next game never re-plants it.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
const mockSocket = { connected: true, connect: jest.fn(), disconnect: jest.fn(), removeAllListeners: jest.fn(), emit: jest.fn() };
const mockIo = jest.fn(() => mockSocket);
jest.mock("socket.io-client", () => ({ io: () => mockIo() }));
const UPLOADED = "/temp/" + "c".repeat(32) + ".jpg";
const mockUpload = jest.fn(async (..._args: unknown[]) => UPLOADED);
jest.mock("../app/utils/uploadPhoto", () => ({ uploadPhoto: (...args: unknown[]) => mockUpload(...args) }));

import { GameProvider, useGameContext } from "../app/providers/GameContext";

let ctx!: ReturnType<typeof useGameContext>;
const Probe = () => { ctx = useGameContext(); return null; };

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });
beforeEach(() => { mockUpload.mockClear(); mockSocket.emit.mockClear(); });

const mount = () => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(<GameProvider><Probe /></GameProvider>); });
  act(() => ctx.startSocket());
  act(() => ctx.saveRejoinToken("ABC123", "bob", "tok"));
  return r;
};

describe("GameContext planted photo", () => {
  it("plantPhoto uploads the picked photo and sends plant-photo right away", async () => {
    const r = mount();
    act(() => ctx.setPlantedPhotoUri("file:///picked.jpg"));
    let ok = false;
    await act(async () => { ok = await ctx.plantPhoto(); });
    expect(ok).toBe(true);
    expect(mockUpload).toHaveBeenCalledWith(expect.any(String), "file:///picked.jpg", { gameCode: "ABC123", token: "tok" });
    expect(mockSocket.emit).toHaveBeenCalledWith("plant-photo", { photoUrl: UPLOADED });
    expect(ctx.plantedPhotoSent).toBe(true);
    expect(ctx.plantedPhotoUri).toBe("file:///picked.jpg"); // still shown as planted in the lobby
    act(() => r.unmount());
  });

  it("Play again (EXP-172): the lobby reuses the connected socket and the planted photo is dropped without it", () => {
    const r = mount();
    const first = ctx.socket;
    const ioCalls = mockIo.mock.calls.length;
    mockSocket.disconnect.mockClear();
    act(() => ctx.setPlantedPhotoUri("file:///picked.jpg"));
    act(() => ctx.setPlantedPhotoUri(null)); // FinalScoreModal's Play again
    act(() => ctx.startSocket()); // WaitingRoom mount
    expect(ctx.plantedPhotoUri).toBeNull();
    expect(ctx.socket).toBe(first);
    expect(mockIo.mock.calls.length).toBe(ioCalls);
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("is cleared when the game socket ends (exit, leave, kicked)", async () => {
    const r = mount();
    act(() => ctx.setPlantedPhotoUri("file:///picked.jpg"));
    await act(async () => { await ctx.plantPhoto(); });
    act(() => ctx.endSocket());
    expect(ctx.plantedPhotoUri).toBeNull();
    expect(ctx.plantedPhotoSent).toBe(false);
    // Nothing left to plant in the next game
    let ok = true;
    await act(async () => { ok = await ctx.plantPhoto(); });
    expect(ok).toBe(false);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it("a failed upload stays pending (retried later), and a photo replaced while uploading is not sent", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const r = mount();
    mockUpload.mockRejectedValueOnce(new Error("network"));
    act(() => ctx.setPlantedPhotoUri("file:///a.jpg"));
    await act(async () => { await ctx.plantPhoto(); });
    expect(ctx.plantedPhotoUri).toBe("file:///a.jpg");
    expect(ctx.plantedPhotoSent).toBe(false);
    expect(mockSocket.emit).not.toHaveBeenCalledWith("plant-photo", expect.anything());

    let release!: (url: string) => void;
    mockUpload.mockImplementationOnce(() => new Promise<string>((res) => { release = res; }));
    let first!: Promise<boolean>;
    act(() => { first = ctx.plantPhoto(); });
    act(() => ctx.setPlantedPhotoUri("file:///b.jpg")); // changed photo while A uploads
    await act(async () => { release("/temp/" + "a".repeat(32) + ".jpg"); expect(await first).toBe(false); });
    expect(mockSocket.emit).not.toHaveBeenCalledWith("plant-photo", expect.anything());
    act(() => r.unmount());
  });
});
