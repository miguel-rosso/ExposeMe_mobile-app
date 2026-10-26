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

  it("a new request asks for an upload; its photo is sent while in force", () => {
    const socket = makeSocket();
    const tr = mount(socket);
    let needsUpload = false;
    act(() => { needsUpload = tr().start(turn1); });
    expect(needsUpload).toBe(true);
    expect(tr().isCurrent(turn1)).toBe(true);
    tr().sendPhoto(turn1, "/temp/a.jpg");
    expect(socket.emit).toHaveBeenCalledWith("photo-sent", { photo: "/temp/a.jpg" });
  });

  it("after endTurn the photo is not sent, and the same request re-asked re-sends it", () => {
    const socket = makeSocket();
    const tr = mount(socket);
    act(() => { tr().start(turn1); });
    act(() => tr().endTurn());
    expect(tr().isCurrent(turn1)).toBe(false);
    tr().sendPhoto(turn1, "/temp/a.jpg");
    expect(socket.emit).not.toHaveBeenCalled();
    let needsUpload = true;
    act(() => { needsUpload = tr().start(turn1); });
    expect(needsUpload).toBe(false);
    expect(socket.emit).toHaveBeenCalledWith("photo-sent", { photo: "/temp/a.jpg" });
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
    expect(tr().takeReportedReason()).toBe("upload");
    expect(tr().takeReportedReason()).toBeNull();
    // A later your-turn of the same request uploads again (the failed upload was forgotten)
    let needsUpload = false;
    act(() => { needsUpload = tr().start(turn1); });
    expect(needsUpload).toBe(true);
  });

  // EXP-237: a new photo wait or a rejoin snapshot means the round-skipped answering my report already went by
  it("endTurn({ forgetReport }) drops my report reason; a plain endTurn keeps it for the round-skipped", () => {
    const tr = mount(makeSocket());
    act(() => { tr().start(turn1); });
    act(() => tr().reportUnavailable("permission", turn1));
    act(() => tr().endTurn());
    expect(tr().takeReportedReason()).toBe("permission");

    act(() => { tr().start({ round: 1, attempt: 2 }); });
    act(() => tr().reportUnavailable("no-photos", { round: 1, attempt: 2 }));
    act(() => tr().endTurn({ forgetReport: true }));
    expect(tr().takeReportedReason()).toBeNull();
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

  // EXP-269: a pause only suspends my request: its upload goes on (the server accepts it) and is re-sent on resume
  it("endTurn({ suspended }) keeps the request's upload wanted, sends nothing, and the resume re-sends the photo", () => {
    const socket = makeSocket();
    const tr = mount(socket);
    act(() => { tr().start(turn1); });
    act(() => tr().endTurn({ suspended: true })); // game-paused
    expect(tr().isCurrent(turn1)).toBe(false);
    expect(tr().isSuspended(turn1)).toBe(true);
    expect(tr().isSuspended({ round: 1, attempt: 2 })).toBe(false);
    act(() => tr().endTurn({ suspended: true, forgetReport: true })); // game-state while paused: still suspended
    expect(tr().isSuspended(turn1)).toBe(true);
    tr().sendPhoto(turn1, "/temp/a.jpg"); // the upload finished during the pause
    expect(socket.emit).not.toHaveBeenCalled();
    let needsUpload = true;
    act(() => { needsUpload = tr().start(turn1); }); // resume's your-turn
    expect(needsUpload).toBe(false);
    expect(socket.emit).toHaveBeenCalledWith("photo-sent", { photo: "/temp/a.jpg" });
    expect(tr().isSuspended(turn1)).toBe(false);
  });

  it("a plain endTurn (waiting-photo, round-start, round-skipped, game-over) cuts a suspended request", () => {
    const tr = mount(makeSocket());
    act(() => { tr().start(turn1); });
    act(() => tr().endTurn({ suspended: true }));
    act(() => tr().endTurn());
    expect(tr().isSuspended(turn1)).toBe(false);
    expect(tr().isCurrent(turn1)).toBe(false);
  });
});
