#!/usr/bin/env node
// Device render skew of one game (EXP-012), from the server's QA telemetry (QA_TELEMETRY_FILE, see Server/GAME_FLOW.md
// "QA render telemetry"): one JSON line per qa-ack { gameCode, username, phase, round, at, receivedAt, handledAt?,
// serverAt? }. For every round + phase rendered by at least two devices, the skew is the spread of the ack receipt times
// (server clock); prints p50/p95/max of that skew per phase as JSON, and per device and phase (EXP-223) the delivery delay
// (server emit → the device's socket handler) and the handler → paint cost, p50/p95.
//
// Usage: node qa/lab/render-skew.mjs <telemetry.jsonl> <gameCode>
import { readFileSync } from "node:fs";
import { percentile } from "./stats.mjs";

const PHASES = ["waiting-photo", "answering", "reveal", "scores"];

/** Acks of `gameCode` from JSON lines; blank, malformed and other games' lines are skipped. */
function parseAcks(text, gameCode) {
  return text.split("\n").flatMap((line) => {
    try {
      const ack = JSON.parse(line);
      return ack?.gameCode === gameCode && Number.isFinite(ack.receivedAt) ? [ack] : [];
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
const acks = parseAcks(readFileSync(file, "utf8"), gameCode);
console.log(JSON.stringify({ gameCode, ...renderSkew(acks), latency: deviceLatency(acks) }, null, 2));
