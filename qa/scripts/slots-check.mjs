#!/usr/bin/env node
// Throughput guard for the QA loop: are enough fixers writing code?
// Prints JSON {short, fixers, open, msg}. Used by dashboard-hook.sh (Stop / PostToolUse on Agent).
// - fixers: activity rows "en curso" whose agent is qa-fixer (a fixer in a rework round counts; a unit waiting for review does not)
// - open: issues with status "open" (blocked ones wait on the user and don't count)
// - quiet when the loop is idle (no activity in the last 2 h) or when backlog.slots_note was written in the last 30 min
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_FIXERS = 3;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const now = Date.now();

let b;
try {
  b = JSON.parse(fs.readFileSync(path.join(ROOT, "qa/backlog.json"), "utf8"));
} catch {
  console.log(JSON.stringify({ short: false }));
  process.exit(0);
}
const activity = b.activity ?? [];
const fixers = activity.filter((a) => a.state === "en curso" && a.agent === "qa-fixer").length;
const open = (b.issues ?? []).filter((i) => i.status === "open").length;
const lastAt = Math.max(0, ...activity.map((a) => Date.parse(a.at) || 0));
const idle = now - lastAt > 2 * 3600e3;
const noteAt = Date.parse(b.slots_note?.at ?? "") || 0;
const excused = now - noteAt < 30 * 60e3;
const short = !idle && !excused && open > 0 && fixers < MIN_FIXERS;
const msg = short
  ? `QA loop throughput: only ${fixers} qa-fixer(s) running (minimum ${MIN_FIXERS}) and ${open} open issue(s). ` +
    `Start fixers now on file-disjoint issues (exposeme-qa-loop step 2), or, if none is compatible with the files in flight, ` +
    `record why in qa/backlog.json as "slots_note": {"at": "<ISO now>", "text": "<reason in Spanish>"} (valid 30 min).`
  : "";
console.log(JSON.stringify({ short, fixers, open, msg }));
