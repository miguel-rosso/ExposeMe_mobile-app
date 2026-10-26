import fs from "fs";
import path from "path";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { TURN_ENDING_EVENTS, useTurnRequest } from "../app/hooks/useTurnRequest";

// EXP-232: lifecycle of my own photo request, extracted from GameScreen

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());

const makeSocket = () => ({ emit: jest.fn() });
type TurnRequest = ReturnType<typeof useTurnRequest>;

// Renders the hook in a probe component; returns a getter for its latest value
const mount = (socket: ReturnType<typeof makeSocket>) => {
  const ref: { current: TurnRequest | null } = { current: null };
  const Probe = () => { ref.current = useTurnRequest(socket as any); return null; };
  act(() => { TestRenderer.create(<Probe />); });
  return () => ref.current!;
};

const turn1 = { round: 1, attempt: 1 };

describe("useTurnRequest", () => {
  it("lists the same turn-ending events as the bots (qa/lab/bots.mjs TURN_ENDING_EVENTS)", () => {
    const bots = fs.readFileSync(path.join(__dirname, "../../qa/lab/bots.mjs"), "utf8");
    const set = bots.match(/const TURN_ENDING_EVENTS = new Set\(\[([^\]]*)\]\)/);
    expect(set).not.toBeNull();
    const botEvents = [...set![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...TURN_ENDING_EVENTS].sort()).toEqual(botEvents.sort());
  });

  it("a new request asks for an upload and shows uploading; its photo is sent while in force", () => {
    const socket = makeSocket();
    const tr = mount(socket);
    let needsUpload = false;
    act(() => { needsUpload = tr().start(turn1); });
    expect(needsUpload).toBe(true);
    expect(tr().uploading).toBe(true);
    expect(tr().isCurrent(turn1)).toBe(true);
    tr().sendPhoto(turn1, "/temp/a.jpg");
    expect(socket.emit).toHaveBeenCalledWith("photo-sent", { photo: "/temp/a.jpg" });
  });

  it("after endTurn the photo is not sent, uploading stops, and the same request re-asked re-sends it", () => {
    const socket = makeSocket();
    const tr = mount(socket);
    act(() => { tr().start(turn1); });
    act(() => tr().endTurn());
    expect(tr().uploading).toBe(false);
    expect(tr().isCurrent(turn1)).toBe(false);
    tr().sendPhoto(turn1, "/temp/a.jpg");
    expect(socket.emit).not.toHaveBeenCalled();
    let needsUpload = true;
    act(() => { needsUpload = tr().start(turn1); });
    expect(needsUpload).toBe(false);
    expect(socket.emit).toHaveBeenCalledWith("photo-sent", { photo: "/temp/a.jpg" });
  });

  it("endTurn({ keepUploading }) keeps showing uploading (pause)", () => {
    const tr = mount(makeSocket());
    act(() => { tr().start(turn1); });
    act(() => tr().endTurn({ keepUploading: true }));
    expect(tr().uploading).toBe(true);
    expect(tr().isCurrent(turn1)).toBe(false);
  });

  it("re-asked while its upload is in flight: waits for it; a new attempt uploads again", () => {
    const tr = mount(makeSocket());
    act(() => { tr().start(turn1); });
    let needsUpload = true;
    act(() => { needsUpload = tr().start(turn1); });
    expect(needsUpload).toBe(false);
    act(() => { needsUpload = tr().start({ round: 1, attempt: 2 }); });
    expect(needsUpload).toBe(true);
  });

  it("reportUnavailable emits for the request in force and keeps the reason until taken once", () => {
    const socket = makeSocket();
    const tr = mount(socket);
    act(() => { tr().start(turn1); });
    act(() => tr().reportUnavailable("upload", turn1));
    expect(socket.emit).toHaveBeenCalledWith("photo-unavailable", { round: 1, attempt: 1 });
    expect(tr().uploading).toBe(false);
    expect(tr().takeReportedReason()).toBe("upload");
    expect(tr().takeReportedReason()).toBeNull();
    // A later your-turn of the same request uploads again (the failed upload was forgotten)
    let needsUpload = false;
    act(() => { needsUpload = tr().start(turn1); });
    expect(needsUpload).toBe(true);
  });

  it("a stale request reports nothing", () => {
    const socket = makeSocket();
    const tr = mount(socket);
    act(() => { tr().start(turn1); });
    act(() => tr().endTurn());
    act(() => tr().reportUnavailable("failed", turn1));
    expect(socket.emit).not.toHaveBeenCalled();
    expect(tr().takeReportedReason()).toBeNull();
  });
});
