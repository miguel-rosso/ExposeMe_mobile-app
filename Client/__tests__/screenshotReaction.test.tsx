import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { Socket } from "socket.io-client";
import { useScreenshotReaction } from "../app/hooks/useScreenshotReaction";
import { SCREENSHOT_EMOJI } from "../app/utils/reactions";

// EXP-274: a screenshot taken offline is not sent. socket.io would buffer it and flush it on the new socket before the
// rejoin, where the server drops it (spending that socket's emoji-reaction limit).

const mockListeners = new Set<() => void>();
jest.mock("expo-screen-capture", () => ({
  addScreenshotListener: (fn: () => void) => {
    mockListeners.add(fn);
    return { remove: () => mockListeners.delete(fn) };
  },
}));

const socket = { connected: true, emit: jest.fn() };
const Probe = () => { useScreenshotReaction(socket as unknown as Socket); return null; };
const takeScreenshot = () => act(() => [...mockListeners].forEach((fn) => fn()));

describe("useScreenshotReaction offline (EXP-274)", () => {
  it("sends nothing while offline and spends no cooldown; the next screenshot once back is sent", () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<Probe />); });
    socket.connected = false;
    takeScreenshot();
    expect(socket.emit).not.toHaveBeenCalled();

    socket.connected = true;
    takeScreenshot();
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith("emoji-reaction", { emoji: SCREENSHOT_EMOJI });
    act(() => r.unmount());
  });
});
