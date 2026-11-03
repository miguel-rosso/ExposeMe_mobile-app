#!/usr/bin/env node
// Device render skew of one game (EXP-012), from the server's QA telemetry (QA_TELEMETRY_FILE, see Server/GAME_FLOW.md
// "QA render telemetry"): one JSON line per qa-ack { gameCode, username, phase, round, at, receivedAt, handledAt?,
// serverAt? }. For every round + phase rendered by at least two devices, the skew is the spread of the ack receipt times
// (server clock); prints p50/p95/max of that skew per phase as JSON, and per device and phase (EXP-223) the delivery delay
// (server emit → the device's socket handler) and the handler → paint cost, p50/p95.
// Per platform (EXP-395) `photoVisible`: from a device's answering paint (its qa-ack) to its round photo on screen (its
// qa-photo-shown line, `kind: "photo-shown"`, same device clock), p50/p95/max, how many photos failed to draw and how
// many painted rounds never showed their photo: `missing` if the device stayed on the round until its reveal or scores,
// `missingLeft` if it left (or may have been offline) first. A p95 above PHOTO_VISIBLE_P95_BOUND_MS, or any failed or
// missing photo, is a warning (not `missingLeft`): listed in `warnings` and printed to stderr as `WARN …`.
//
// Usage: node qa/lab/render-skew.mjs <telemetry.jsonl> <gameCode>
import { readFileSync } from "node:fs";
import { percentile } from "./stats.mjs";

const PHASES = ["waiting-photo", "answering", "reveal", "scores"];
const PHOTO_SHOWN = "photo-shown";
// Answering paint → photo on screen, p95 per platform. Lenient on purpose: a ~300-600 KB photo over the lab's Wi-Fi
// takes well under a second; 3 s of an 8 s answer bar showing only a spinner is a regression worth a look.
const PHOTO_VISIBLE_P95_BOUND_MS = 3_000;
// The longest a round's photo can still show up after its answering paint: answering (7.7 s), reveal (3 s) and scores
// (5 s) with the whole hold budget (30 s), rounded up. A photo, or a round-start paint, later than this after a round's
// first paint belongs to that round number in another game (play again in the same room restarts the rounds at 1).
const PAINT_TO_PHOTO_MAX_MS = 60_000;

/** Telemetry lines of `gameCode` from JSON lines; blank, malformed and other games' lines are skipped. */
function parseRecords(text, gameCode) {
  return text.split("\n").flatMap((line) => {
    try {
      const record = JSON.parse(line);
      return record?.gameCode === gameCode && Number.isFinite(record.receivedAt) ? [record] : [];
    } catch { return []; }
  });
}

/**
 * Per phase: how many round instances two or more devices rendered, and the p50/p95/max spread (ms) of their receipt
 * times. Only a device's earliest ack of a round + phase counts (a resume or rejoin re-acks the same phase later), whatever
 * the order of the lines.
 */
function renderSkew(acks) {
  const firstAck = new Map(); // "round|phase" -> Map(username -> earliest receivedAt)
  for (const { username, phase, round, receivedAt } of acks) {
    const key = `${round}|${phase}`;
    if (!firstAck.has(key)) firstAck.set(key, new Map());
    const byDevice = firstAck.get(key);
    byDevice.set(username, Math.min(receivedAt, byDevice.get(username) ?? Infinity));
  }
  const spreads = Object.fromEntries(PHASES.map((p) => [p, []]));
  for (const [key, byDevice] of firstAck) {
    const phase = key.slice(key.indexOf("|") + 1);
    if (byDevice.size < 2 || !spreads[phase]) continue;
    const times = [...byDevice.values()];
    spreads[phase].push(Math.max(...times) - Math.min(...times));
  }
  const phases = {};
  for (const [phase, list] of Object.entries(spreads)) {
    if (!list.length) continue;
    const sorted = list.sort((a, b) => a - b);
    phases[phase] = { instances: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) };
  }
  return { devices: [...new Set(acks.map((a) => a.username))].sort(), phases };
}

/** `[a, b]` pairs sorted by `a`, as an object (stable output order). */
const sortedObject = (pairs) => Object.fromEntries([...pairs].sort(([a], [b]) => a.localeCompare(b)));

/** Painted by a resume or rejoin, not by its phase's event (the socket may have been down just before) */
const isResumed = (ack) => !Number.isFinite(ack.handledAt);

/** The latest of `rounds` that `record`'s device played with its round number at most PAINT_TO_PHOTO_MAX_MS before it */
const roundOf = (rounds, record) => rounds.findLast((r) => r.username === record.username && r.round === record.round
  && r.paintedAt <= record.at && record.at - r.paintedAt <= PAINT_TO_PHOTO_MAX_MS);

/**
 * The rounds each device played, from its answering paints, each with its first paint time and the device's platform.
 * A resumed or rejoined paint paints again the latest round of that number; so does one within PAINT_TO_PHOTO_MAX_MS of
 * it. Any other is that round number in another game.
 *
 * Each round also says whether the device stayed on it past answering (`stayed`: it acked that round's reveal or
 * scores) and whether it may have been offline during it (`interrupted`: its answering or reveal was painted by a
 * resume or rejoin, so a photo drawn meanwhile could not be acked).
 */
function roundsPlayed(acks) {
  const rounds = [];
  for (const paint of acks.filter((a) => a.phase === "answering").sort((a, b) => a.at - b.at)) {
    const played = rounds.findLast((r) => r.username === paint.username && r.round === paint.round);
    if (played && (isResumed(paint) || paint.at - played.paintedAt <= PAINT_TO_PHOTO_MAX_MS)) {
      played.interrupted ||= isResumed(paint);
      continue;
    }
    const { username, round, at: paintedAt, platform } = paint;
    rounds.push({ username, round, paintedAt, platform, photo: null, stayed: false, interrupted: false });
  }
  for (const later of acks.filter((a) => a.phase === "reveal" || a.phase === "scores")) {
    const played = roundOf(rounds, later);
    if (!played) continue;
    played.stayed = true;
    played.interrupted ||= later.phase === "reveal" && isResumed(later);
  }
  return rounds;
}

/**
 * Per platform (EXP-395): the time (ms, device clock) from each round's first answering paint to its first photo-shown,
 * how many of those photos failed to draw, and the rounds painted with no photo-shown at all: `missing` when the device
 * stayed on the round, uninterrupted, until its reveal or scores (a photo that never loaded nor failed: a spinner all
 * round), else `missingLeft` (it left the game screen during answering: leave, kick, game over; or it may have been
 * offline when the photo drew). A photo belongs to the latest round its device painted with that number at most
 * PAINT_TO_PHOTO_MAX_MS before it; one with no such round (rejoined at the reveal) has no time, though a failed one
 * still counts as failed.
 */
function photoVisible(acks, photos) {
  const rounds = roundsPlayed(acks);
  const byPlatform = new Map();
  const ofPlatform = (name = "unknown") => {
    if (!byPlatform.has(name)) byPlatform.set(name, { times: [], failed: 0, missing: 0, missingLeft: 0 });
    return byPlatform.get(name);
  };
  for (const photo of [...photos].sort((a, b) => a.at - b.at)) {
    const played = roundOf(rounds, photo);
    if (played?.photo) continue; // shown again (a remount): only the first counts
    if (played) played.photo = photo;
    else if (photo.failed) ofPlatform(photo.platform).failed++;
  }
  for (const { paintedAt, platform, photo, stayed, interrupted } of rounds) {
    const stats = ofPlatform(platform ?? photo?.platform);
    if (!photo && stayed && !interrupted) stats.missing++;
    else if (!photo) stats.missingLeft++;
    else if (photo.failed) stats.failed++;
    else stats.times.push(photo.at - paintedAt);
  }
  const platforms = sortedObject([...byPlatform].map(([name, { times, ...counts }]) => [
    name, { ...summary(times), max: times.length ? Math.max(...times) : null, ...counts },
  ]));
  return { p95BoundMs: PHOTO_VISIBLE_P95_BOUND_MS, platforms };
}

/**
 * The photo-visible results over their bound: a slow p95, photos that never drew, rounds played through with no photo
 * shown (not `missingLeft`: the device was not there, or not online, to show it).
 */
function photoWarnings({ p95BoundMs, platforms }) {
  return Object.entries(platforms).flatMap(([name, { p95, failed, missing }]) => [
    ...(p95 > p95BoundMs ? [`photoVisible ${name}: p95 ${p95} ms > ${p95BoundMs} ms`] : []),
    ...(failed ? [`photoVisible ${name}: ${failed} photo(s) failed to draw`] : []),
    ...(missing ? [`photoVisible ${name}: ${missing} round(s) painted with no photo shown`] : []),
  ]);
}

/** `{ n, p50, p95 }` of a list of ms values. */
const summary = (values) => ({ n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) });

/**
 * Device clock minus server clock (ms) for one device, NTP-style: from its ack with the shortest round trip (server emit
 * → device handler, then device paint → server receipt; the time spent on the device doesn't count), assuming both legs
 * of that trip took as long. null without an ack that has both handledAt and serverAt (and a possible round trip).
 */
function clockOffset(acks) {
  let best = null;
  for (const { serverAt, handledAt, at, receivedAt } of acks) {
    if (!Number.isFinite(serverAt) || !Number.isFinite(handledAt)) continue;
    const roundTrip = (receivedAt - serverAt) - (at - handledAt);
    if (roundTrip < 0) continue; // impossible: serverAt is not the broadcast this ack answers
    if (!best || roundTrip < best.roundTrip) best = { roundTrip, offset: ((handledAt - serverAt) - (receivedAt - at)) / 2 };
  }
  return best && Math.round(best.offset);
}

/**
 * Per device: its clock offset and, per phase, the delivery delay (serverAt → handledAt, on the server clock) and the
 * handler → paint cost (handledAt → at, both on the device clock). Acks without handledAt (a resumed or rejoined phase)
 * don't count; a delivery also needs serverAt and the device's clock offset.
 */
function deviceLatency(acks) {
  const byDevice = Map.groupBy(acks.filter((a) => Number.isFinite(a.handledAt)), (a) => a.username);
  const latency = {};
  for (const [username, deviceAcks] of [...byDevice].sort(([a], [b]) => a.localeCompare(b))) {
    const offset = clockOffset(deviceAcks);
    const phases = {};
    for (const phase of PHASES) {
      const ofPhase = deviceAcks.filter((a) => a.phase === phase);
      if (!ofPhase.length) continue;
      const delivery = offset === null ? [] : ofPhase.filter((a) => Number.isFinite(a.serverAt))
        .map((a) => a.handledAt - offset - a.serverAt);
      phases[phase] = {
        ...(delivery.length ? { delivery: summary(delivery) } : {}),
        handlerToPaint: summary(ofPhase.map((a) => a.at - a.handledAt)),
      };
    }
    latency[username] = { clockOffset: offset, phases };
  }
  return latency;
}

const [file, gameCode] = process.argv.slice(2);
if (!file || !gameCode) {
  console.error("usage: node qa/lab/render-skew.mjs <telemetry.jsonl> <gameCode>");
  process.exit(2);
}
const records = parseRecords(readFileSync(file, "utf8"), gameCode);
const acks = records.filter((r) => r.kind === undefined);
const photo = photoVisible(acks, records.filter((r) => r.kind === PHOTO_SHOWN));
const warnings = photoWarnings(photo);
warnings.forEach((w) => console.error(`WARN ${w}`));
console.log(JSON.stringify({
  gameCode, ...renderSkew(acks), latency: deviceLatency(acks), photoVisible: photo, warnings,
}, null, 2));
