#!/usr/bin/env node
// Device render skew of one game (EXP-012), from the server's QA telemetry (QA_TELEMETRY_FILE, see Server/GAME_FLOW.md
// "QA render telemetry"): one JSON line per qa-ack { gameCode, username, phase, round, at, receivedAt }.
// For every round + phase rendered by at least two devices, the skew is the spread of the ack receipt times (server
// clock); prints p50/p95/max of that skew per phase as JSON.
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

const [file, gameCode] = process.argv.slice(2);
if (!file || !gameCode) {
  console.error("usage: node qa/lab/render-skew.mjs <telemetry.jsonl> <gameCode>");
  process.exit(2);
}
console.log(JSON.stringify({ gameCode, ...renderSkew(parseAcks(readFileSync(file, "utf8"), gameCode)) }, null, 2));
