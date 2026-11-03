import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaTelemetry, isQaAck, isQaPhotoShown, QaAckRecord, QaPhotoShownRecord } from "../managers/qaTelemetry";

// EXP-012: dev/QA-only render telemetry. The sink exists only with QA_TELEMETRY=1 and payloads are validated.

const ENTRY: QaAckRecord = {
  gameCode: "ABCDEF", username: "alice", phase: "answering", round: 2, at: 1_000, platform: "ios", receivedAt: 1_050,
};

describe("isQaAck", () => {
  it("accepts a round phase, a round number, a device time and the platform", () => {
    for (const phase of ["waiting-photo", "answering", "reveal", "scores"]) {
      expect(isQaAck({ phase, round: 1, at: Date.now(), platform: "ios" })).toBe(true);
    }
    expect(isQaAck({ phase: "scores", round: 0, at: 0, platform: "android" })).toBe(true);
    expect(isQaAck({ phase: "scores", round: 1, at: 10, platform: "ios", handledAt: 4 })).toBe(true); // EXP-223
  });

  it("rejects anything else", () => {
    const bad: unknown[] = [
      null, undefined, "answering", 42, [],
      { phase: "lobby", round: 1, at: 1, platform: "ios" },
      { phase: "answering", round: -1, at: 1, platform: "ios" },
      { phase: "answering", round: 1.5, at: 1, platform: "ios" },
      { phase: "answering", round: "1", at: 1, platform: "ios" },
      { phase: "answering", round: 1_000_001, at: 1, platform: "ios" },
      { phase: "answering", round: 1, at: "now", platform: "ios" },
      { phase: "answering", round: 1, at: Number.NaN, platform: "ios" },
      { phase: "answering", round: 1, at: Number.POSITIVE_INFINITY, platform: "ios" },
      { phase: "answering", round: 1, platform: "ios" },
      { phase: "answering", round: 1, at: 1, handledAt: "now", platform: "ios" },
      { phase: "answering", round: 1, at: 1, handledAt: Number.NaN, platform: "ios" },
      { phase: "answering", round: 1, at: 1, handledAt: null, platform: "ios" },
      { phase: "answering", round: 1, at: 1 }, // EXP-395: the platform is required
      { phase: "answering", round: 1, at: 1, platform: "web" },
    ];
    for (const data of bad) expect(isQaAck(data), JSON.stringify(data)).toBe(false);
  });
});

// EXP-395: when the round photo is actually on screen (or failed to draw), per platform
describe("isQaPhotoShown", () => {
  const SHOWN = { phase: "answering", round: 1, at: 1_000, platform: "ios" };

  it("accepts a round phase, a round number, a device time and the platform, optionally flagged failed", () => {
    expect(isQaPhotoShown(SHOWN)).toBe(true);
    expect(isQaPhotoShown({ ...SHOWN, phase: "reveal", platform: "android" })).toBe(true);
    expect(isQaPhotoShown({ ...SHOWN, failed: true })).toBe(true);
  });

  it("rejects anything else", () => {
    const bad: unknown[] = [
      null, "answering", [],
      { ...SHOWN, platform: undefined },
      { ...SHOWN, platform: "web" },
      { ...SHOWN, phase: "lobby" },
      { ...SHOWN, round: -1 },
      { ...SHOWN, at: Number.NaN },
      { ...SHOWN, failed: false },
      { ...SHOWN, failed: "yes" },
    ];
    for (const data of bad) expect(isQaPhotoShown(data), JSON.stringify(data)).toBe(false);
  });
});

describe("createQaTelemetry", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.restoreAllMocks();
  });

  it("is off unless QA_TELEMETRY=1", () => {
    expect(createQaTelemetry({})).toBeNull();
    expect(createQaTelemetry({ QA_TELEMETRY: "0", QA_TELEMETRY_FILE: "/tmp/x" })).toBeNull();
    expect(createQaTelemetry({ QA_TELEMETRY: "true" })).toBeNull();
  });

  it("appends one JSON line per record to QA_TELEMETRY_FILE, in order", () => {
    dir = mkdtempSync(join(tmpdir(), "qa-telemetry-"));
    const file = join(dir, "telemetry.jsonl");
    const telemetry = createQaTelemetry({ QA_TELEMETRY: "1", QA_TELEMETRY_FILE: file })!;
    const users = ["alice", "bob", "carol", "dave", "erin"];
    users.forEach((username) => telemetry.record({ ...ENTRY, username }));
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual(users.map((username) => ({ ...ENTRY, username })));
  });

  it("appends photo-shown records to the same file, tagged with their kind (EXP-395)", () => {
    dir = mkdtempSync(join(tmpdir(), "qa-telemetry-"));
    const file = join(dir, "telemetry.jsonl");
    const telemetry = createQaTelemetry({ QA_TELEMETRY: "1", QA_TELEMETRY_FILE: file })!;
    const shown: QaPhotoShownRecord = { ...ENTRY, kind: "photo-shown", platform: "android", failed: true };
    telemetry.record(ENTRY);
    telemetry.record(shown);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([ENTRY, shown]);
  });

  it("logs a failed write instead of throwing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const telemetry = createQaTelemetry({ QA_TELEMETRY: "1", QA_TELEMETRY_FILE: "/nonexistent-exposeme-dir/t.jsonl" })!;
    expect(() => telemetry.record(ENTRY)).not.toThrow();
    expect(error).toHaveBeenCalledWith("qa-ack write error:", expect.any(String));
  });

  it("logs the record when no file is set", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    createQaTelemetry({ QA_TELEMETRY: "1" })!.record(ENTRY);
    expect(log).toHaveBeenCalledWith(`[qa-ack] ${JSON.stringify(ENTRY)}`);
  });
});
