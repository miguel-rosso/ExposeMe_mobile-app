import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine, PAUSE_MIN_DURATION, PAUSE_TIMEOUT } from "../managers/GameEngine";
import { DISCONNECT_GRACE, RoomManager } from "../managers/RoomManager";
import { Room, YourTurnData } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

// EXP-016 / EXP-021 / EXP-014: keeps Server/GAME_FLOW.md honest. The event tables must list exactly the events the
// server emits and handles, and the `{ ... }` payloads documented for GameEngine events must match what it emits.

const SERVER_DIR = join(__dirname, "..");
const DOC = readFileSync(join(SERVER_DIR, "GAME_FLOW.md"), "utf8");
const SERVER_TO_CLIENT_HEADING = "## Events (Server → Client)";
const CLIENT_TO_SERVER_HEADING = "## Events (Client → Server)";
// socket.io's own lifecycle event, not part of the game protocol
const BUILT_IN_EVENTS = new Set(["disconnect"]);

// ── Doc parsing ──────────────────────────────────────

/** Rows of the markdown table under `heading`, as trimmed cells (`\|` inside a cell is not a separator). */
function tableRows(heading: string): string[][] {
  const start = DOC.indexOf(heading);
  expect(start, `GAME_FLOW.md has no "${heading}" section`).toBeGreaterThanOrEqual(0);
  const section = DOC.slice(start + heading.length).split(/\n## /)[0];
  return section
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim()));
}

/** Event name → its Data cell, for one of the event tables (Server → Client has a Phase column before Data). */
function documentedEvents(heading: string, dataColumn: number): Map<string, string> {
  return new Map(tableRows(heading).map((cells) => [cells[0].replace(/`/g, ""), cells[dataColumn]]));
}

interface DocKeys { required: string[]; optional: string[] }

/** Top-level keys of a documented payload like `` `{ round, reason: "a" \| "b", message? }` ``; null if not an object. */
function payloadKeys(data: string): DocKeys | null {
  const match = data.match(/^`\{(.*)\}`/s);
  if (!match) return null;
  const keys: DocKeys = { required: [], optional: [] };
  for (const part of match[1].split(",")) {
    const key = part.trim().match(/^(\w+)(\?)?/);
    if (key) (key[2] ? keys.optional : keys.required).push(key[1]);
  }
  return keys;
}

// ── Source scanning ──────────────────────────────────

// A string literal (kept as is) or a comment (dropped): strings match first, so a `//` inside one is not a comment
const STRING_OR_COMMENT = /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
// What must follow `.emit(` / `socket.on(`: the event name as a plain string literal, in any quote style
const EVENT_NAME_LITERAL = /^\s*(["'`])([a-z-]+)\1/;
const EMIT_CALL = /\.emit\(/g;
const HANDLER_CALL = /\bsocket\.on\(/g;

function withoutComments(source: string): string {
  return source.replace(STRING_OR_COMMENT, (_match, literal: string | undefined) => literal ?? "");
}

/** A server source file (path relative to Server/), comments removed. */
function sourceFile(path: string): string {
  return withoutComments(readFileSync(join(SERVER_DIR, path), "utf8"));
}

function sources(dir: string): string {
  return readdirSync(join(SERVER_DIR, dir))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => sourceFile(join(dir, f)))
    .join("\n");
}

/**
 * Event names of every `call` in `source`. A call whose first argument is not a plain string literal can't be checked
 * against the doc, so it fails the test (use a literal event name).
 */
function eventNames(source: string, call: RegExp): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(call)) {
    const rest = source.slice(match.index! + match[0].length);
    const name = rest.match(EVENT_NAME_LITERAL)?.[2];
    expect(name, `${match[0]} with a non-literal event name: ${rest.split("\n")[0]}`).toBeDefined();
    if (!BUILT_IN_EVENTS.has(name!)) names.add(name!);
  }
  return names;
}

const sorted = (names: Iterable<string>) => [...names].sort();

// ── Event names ──────────────────────────────────────

describe("GAME_FLOW.md event tables", () => {
  it("list every event the server emits, and nothing else", () => {
    const emitted = eventNames(sources("managers") + sources("routes"), EMIT_CALL);
    expect(sorted(documentedEvents(SERVER_TO_CLIENT_HEADING, 2).keys())).toEqual(sorted(emitted));
  });

  it("list every event the server handles, and nothing else", () => {
    const handled = eventNames(sources("routes"), HANDLER_CALL);
    expect(sorted(documentedEvents(CLIENT_TO_SERVER_HEADING, 1).keys())).toEqual(sorted(handled));
  });

  it("scans event names in any quote style and skips commented-out calls", () => {
    const source = withoutComments([
      "io.emit(\"a-b\", x); io.emit('c', x); io.emit(`d`, x); socket.on(\"e\", f);",
      "// io.emit(\"commented\", x)",
      "/* socket.on(\"block-commented\", f) */",
      "const url = \"http://example.invalid\"; io.emit(\"after-url\", x);",
    ].join("\n"));
    expect(sorted(eventNames(source, EMIT_CALL))).toEqual(["a-b", "after-url", "c", "d"]);
    expect(sorted(eventNames(source, HANDLER_CALL))).toEqual(["e"]);
  });

  it("fails on a call whose event name is not a string literal", () => {
    expect(() => eventNames("io.emit(EVENT, x)", EMIT_CALL)).toThrow(/non-literal event name/);
    expect(() => eventNames("socket.on(`${prefix}-x`, f)", HANDLER_CALL)).toThrow(/non-literal event name/);
  });
});

// ── Payloads ─────────────────────────────────────────

const GAME_START_DELAY = 1_000;
const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const HOLD_TIME = 1_000;
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";

describe("GAME_FLOW.md payloads", () => {
  let emits: CapturedEmit[];
  let engine: GameEngine;
  let rm: RoomManager;
  let room: Room;

  const player = (name: string) => room.players.find((p) => p.username === name)!;
  const lastEmit = (name: string) => emits.filter((e) => e.event === name).pop()!;

  function drop(name: string): void {
    rm.markDisconnected(room.gameCode, name, player(name).socketId);
    engine.onConnectionChange(room);
  }

  function rejoin(name: string): void {
    const p = player(name);
    rm.joinRoom(room.gameCode, name, `${p.socketId}-2`, p.rejoinToken);
    engine.onPlayerRejoined(room, p);
  }

  /** A game that goes through every GameEngine event: a played round with a hold, a skip, pauses, game over. */
  function playEveryEvent(): void {
    room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    rm.joinRoom(room.gameCode, "carol", "sock-carol");
    engine.startGame(room);
    room.players.forEach((p) => engine.markReady(room, p));
    vi.advanceTimersByTime(GAME_START_DELAY);

    // Round 1: played, the owner holds the scores
    const owner = room.currentPlayer!;
    engine.onPhotoReceived(room, PHOTO, owner.username);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    expect(engine.handleHold(room, owner.socketId)).toBe(true);
    vi.advanceTimersByTime(HOLD_TIME);
    expect(engine.handleRelease(room, owner.socketId)).toBe(true);
    vi.advanceTimersByTime(SCORE_DISPLAY_TIME);

    // Round 2: the owner has no photo
    const turn = lastEmit("your-turn").args[0] as YourTurnData;
    engine.onPhotoUnavailable(room, room.currentPlayer!.username, turn.round, turn.attempt);

    // Fewer than 2 connected: pause, resume on a rejoin, pause again until it expires
    drop("alice");
    drop("bob");
    rejoin("bob");
    vi.advanceTimersByTime(PAUSE_MIN_DURATION);
    drop("bob");
    vi.advanceTimersByTime(PAUSE_TIMEOUT);

    // Back in the lobby: the gone players are shown so
    vi.advanceTimersByTime(DISCONNECT_GRACE);
  }

  /** Documented object payloads by event (`game-state`'s fields are listed in "Pause and reconnect"). */
  function documentedPayloads(): Map<string, DocKeys> {
    const docs = new Map<string, DocKeys>();
    for (const [name, data] of documentedEvents(SERVER_TO_CLIENT_HEADING, 2)) {
      const keys = payloadKeys(data);
      if (keys) docs.set(name, keys);
    }
    const snapshot = DOC.match(/\*\*`game-state`\*\* = (`\{[^`]*\}`)/);
    expect(snapshot, "GAME_FLOW.md documents the game-state fields").not.toBeNull();
    docs.set("game-state", payloadKeys(snapshot![1])!);
    return docs;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fake = createFakeIo();
    emits = fake.emits;
    rm = new RoomManager();
    engine = new GameEngine(fake.io, rm);
  });

  afterEach(() => {
    rm.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cover every documented object payload that GameEngine emits", () => {
    playEveryEvent();
    const engineEvents = eventNames(sourceFile("managers/GameEngine.ts"), EMIT_CALL);
    const captured = new Set(emits.map((e) => e.event));
    const missed = sorted(documentedPayloads().keys()).filter((name) => engineEvents.has(name) && !captured.has(name));
    expect(missed, "GameEngine events with a documented payload that playEveryEvent never emits (extend it)").toEqual([]);
  });

  it("match the keys GameEngine emits", () => {
    playEveryEvent();
    const docs = documentedPayloads();

    for (const { event, args } of emits) {
      const doc = docs.get(event);
      if (!doc) continue; // not an object payload in the doc (e.g. public player, username)
      const keys = Object.keys(args[0] as object);
      expect(keys, `${event} has every documented key`).toEqual(expect.arrayContaining(doc.required));
      expect([...doc.required, ...doc.optional], `${event} has no undocumented key`).toEqual(expect.arrayContaining(keys));
    }
  });
});
