import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine, PAUSE_MIN_DURATION, PAUSE_TIMEOUT } from "../managers/GameEngine";
import { DISCONNECT_GRACE, RoomManager } from "../managers/RoomManager";
import { Room, YourTurnData } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

// EXP-016 / EXP-021 / EXP-014 / EXP-210: keeps Server/GAME_FLOW.md honest. The event tables must list exactly the
// events the server emits and handles, the `{ ... }` payloads documented for GameEngine events must match what it
// emits, and those of socketRoutes must match the payloads it emits and the fields its handlers read.

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
  const match = data.match(/^`\{(.*?)\}`/s);
  if (!match) return null;
  const keys: DocKeys = { required: [], optional: [] };
  for (const part of match[1].split(",")) {
    const key = part.trim().match(/^(\w+)(\?)?/);
    if (key) (key[2] ? keys.optional : keys.required).push(key[1]);
  }
  return keys;
}

// A Data cell for an event without payload: `-`, maybe followed by a note like `- (with an ack callback)`
const NO_PAYLOAD = /^-(\s|$)/;

/** `keys` of an `event` payload include every required key of `doc` and nothing undocumented. */
function expectDocumentedKeys(event: string, keys: string[], doc: DocKeys): void {
  expect(keys, `${event} has every documented key`).toEqual(expect.arrayContaining(doc.required));
  expect([...doc.required, ...doc.optional], `${event} has no undocumented key`).toEqual(expect.arrayContaining(keys));
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

// ── Call arguments ───────────────────────────────────

const QUOTES = "\"'`";
const OPENING_BRACKETS = "([{";
const CLOSING_BRACKETS = ")]}";

/**
 * Index of the quote that closes the string literal opened at `start`. As in STRING_OR_COMMENT, a `'` or `"` string
 * ends on its line: a quote left open there is not a string (e.g. inside a regex literal like `/[']/`), so `start`.
 */
function endOfString(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i;
    else if (text[i] === "\n" && quote !== "`") return start;
  }
  return quote === "`" ? text.length : start;
}

/**
 * The comma-separated top-level items of `text` from `start`, up to an unmatched closing bracket (the end of a call's
 * argument list) or the end of `text`. Nested brackets and string literals stay whole.
 */
function topLevelItems(text: string, start = 0): string[] {
  const items: string[] = [];
  let depth = 0;
  let from = start;
  let i = start;
  for (; i < text.length; i++) {
    const char = text[i];
    if (QUOTES.includes(char)) i = endOfString(text, i);
    else if (OPENING_BRACKETS.includes(char)) depth++;
    else if (CLOSING_BRACKETS.includes(char) && depth-- === 0) break;
    else if (char === "," && depth === 0) {
      items.push(text.slice(from, i));
      from = i + 1;
    }
  }
  items.push(text.slice(from, i));
  return items.map((item) => item.trim()).filter(Boolean);
}

interface Call { event: string; args: string[] }

/** Every `call` in `source` with its event name and the source text of its other arguments. */
function calls(source: string, call: RegExp): Call[] {
  return [...source.matchAll(call)].map((match) => {
    const [name, ...args] = topLevelItems(source, match.index! + match[0].length);
    const event = name?.match(EVENT_NAME_LITERAL)?.[2];
    expect(event, `${match[0]} with a non-literal event name: ${name}`).toBeDefined();
    return { event: event!, args };
  });
}

// A type check after an object literal, as in `{ a } satisfies Payload`: still that object literal
const SATISFIES_SUFFIX = /\s+satisfies\s+\w+$/;

/**
 * Keys of an object literal like `{ a: x, b }` (optionally `satisfies SomeType`); null if `text` is not one. Fails on
 * keys it can't read (spreads).
 */
function objectLiteralKeys(source: string): string[] | null {
  const text = source.replace(SATISFIES_SUFFIX, "");
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  return topLevelItems(text.slice(1, -1)).map((property) => {
    const key = property.match(/^(\w+)\s*(?::|$)/)?.[1];
    expect(key, `object literal with a key that can't be checked against the doc: ${property}`).toBeDefined();
    return key!;
  });
}

/**
 * Payload fields a `socket.on` handler reads from its first parameter, written as `data.x`, `data?.x` or
 * `{ x } = data` (passing `data` to a helper is not followed).
 */
function fieldsRead(handler: string): string[] {
  // `(data: T)` or `data`, then an optional return type: `(data: T): void =>`
  const signature = handler.match(/^(?:async\s*)?(?:\(\s*(\w*)[^)]*\)|(\w+))\s*(?::[^=]+)?=>/);
  expect(signature, `socket.on handler is not an inline arrow function: ${handler.split("\n")[0]}`).not.toBeNull();
  const param = signature![1] || signature![2];
  if (!param) return [];
  const fields = new Set([...handler.matchAll(new RegExp(String.raw`\b${param}\??\.(\w+)`, "g"))].map((m) => m[1]));
  for (const [, destructured] of handler.matchAll(new RegExp(String.raw`\{([^{}]*)\}\s*=\s*${param}\b`, "g"))) {
    topLevelItems(destructured).forEach((field) => fields.add(field.match(/^\w+/)![0]));
  }
  return sorted(fields);
}

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
      expectDocumentedKeys(event, Object.keys(args[0] as object), doc);
    }
  });
});

describe("GAME_FLOW.md socketRoutes payloads", () => {
  const routes = sourceFile("routes/socketRoutes.ts");

  it("match what socketRoutes emits", () => {
    const docs = documentedEvents(SERVER_TO_CLIENT_HEADING, 2);
    for (const { event, args } of calls(routes, EMIT_CALL)) {
      const data = docs.get(event)!; // documented: checked by the event table tests
      const [payload, ...extra] = args;
      expect(extra, `${event} is emitted with at most one payload`).toEqual([]);
      const doc = payloadKeys(data);
      if (NO_PAYLOAD.test(data)) {
        expect(payload, `${event} is documented without data`).toBeUndefined();
      } else if (doc) {
        const keys = objectLiteralKeys(payload ?? "");
        expect(keys, `${event} payload must be an object literal to check it against the doc: ${payload}`).not.toBeNull();
        expectDocumentedKeys(event, keys!, doc);
      } else {
        expect(payload, `${event} is documented with data (${data})`).toBeDefined();
        expect(objectLiteralKeys(payload!), `${event} is documented as ${data}, not as an object`).toBeNull();
      }
    }
  });

  it("match the fields socketRoutes handlers read", () => {
    const docs = documentedEvents(CLIENT_TO_SERVER_HEADING, 1);
    for (const { event, args } of calls(routes, HANDLER_CALL)) {
      if (BUILT_IN_EVENTS.has(event)) continue;
      const data = docs.get(event)!; // documented: checked by the event table tests
      const doc = payloadKeys(data);
      expect(doc !== null || NO_PAYLOAD.test(data), `${event} data must be documented as \`{ ... }\` or -`).toBe(true);
      const documented = doc ? sorted([...doc.required, ...doc.optional]) : [];
      expect(fieldsRead(args[0]), `${event} handler reads exactly the documented fields (as data.x, data?.x or { x } = data; passing data to a helper is not followed)`).toEqual(documented);
    }
  });

  it("read payload keys and handler fields from source", () => {
    const source = withoutComments([
      "io.emit(\"a\", { ok: true, room: f(x, { y }), message: \"a, b}\", nested: { c: 1 }, short });",
      "socket.emit('b', player(p, room)); io.to(code).emit(`c`);",
      "socket.on(\"d\", (data: { x: number }) => { if (data?.x) g(data.y, { z: data?.x }); const { w, v: alias } = data; });",
      "socket.on(\"e\", () => {}); socket.on(\"f\", (ack?: unknown) => { if (typeof ack === \"function\") ack(); });",
      "socket.on(\"g\", (data: unknown) => { try { const { p, q } = data; } catch {} });",
      "socket.on(\"h\", (data: { m: string }): void => { if (/[']/.test(data.m)) return; });",
      "socket.on(\"i\", (data) => { g(data.n, 'a, b) {'); });",
    ].join("\n"));

    const emitted = calls(source, EMIT_CALL);
    expect(emitted.map((e) => e.event)).toEqual(["a", "b", "c"]);
    expect(objectLiteralKeys(emitted[0].args[0])).toEqual(["ok", "room", "message", "nested", "short"]);
    expect(emitted[1].args).toEqual(["player(p, room)"]);
    expect(objectLiteralKeys(emitted[1].args[0])).toBeNull();
    expect(emitted[2].args).toEqual([]);
    expect(objectLiteralKeys("{ ok: true, why } satisfies Reply")).toEqual(["ok", "why"]);
    expect(objectLiteralKeys("reply(x) satisfies Reply")).toBeNull();

    const handlers = calls(source, HANDLER_CALL);
    expect(handlers.map((h) => [h.event, fieldsRead(h.args[0])])).toEqual([
      ["d", ["v", "w", "x", "y"]], ["e", []], ["f", []], ["g", ["p", "q"]], ["h", ["m"]], ["i", ["n"]],
    ]);
  });

  it("fail on payloads and handlers they can't check", () => {
    expect(() => objectLiteralKeys("{ ...rest, a }")).toThrow(/can't be checked/);
    expect(() => objectLiteralKeys("{ [key]: 1 }")).toThrow(/can't be checked/);
    expect(() => fieldsRead("onJoin")).toThrow(/not an inline arrow function/);
    expect(() => calls("io.emit(EVENT, x)", EMIT_CALL)).toThrow(/non-literal event name/);
  });
});
