#!/usr/bin/env node
// Splits qa/backlog.json into the three files the QA dashboard reads
// (issues.json, changes.json, runs.json) under qa/dashboard/.
// After running, upload each file to the dashboard artifact (see the exposeme-qa-loop skill).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const qa = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backlog = JSON.parse(fs.readFileSync(path.join(qa, "backlog.json"), "utf8"));
const out = path.join(qa, "dashboard");
fs.mkdirSync(out, { recursive: true });

const sevRank = { critical: 0, high: 1, medium: 2, low: 3 };
// The dashboard is in Spanish: add display labels next to the raw enum values
const ES = {
  critical: "crítica", high: "alta", medium: "media", low: "baja",
  open: "abierta", "in-progress": "en curso", blocked: "bloqueada", fixed: "resuelta", verified: "verificada", wontfix: "descartada",
  sync: "sincronización", bug: "bug", security: "seguridad", perf: "rendimiento", ux: "UX", test: "tests", infra: "infra",
  server: "servidor", client: "cliente", both: "ambos", lab: "laboratorio", pass: "OK", fail: "fallo",
};
const es = (v) => ES[v] ?? v;
const issues = backlog.issues
  .map((i) => ({ ...i, severity_rank: sevRank[i.severity] ?? 9, severity_es: es(i.severity), status_es: es(i.status), type_es: es(i.type), area_es: es(i.area) }))
  .sort((a, b) => a.severity_rank - b.severity_rank || a.id.localeCompare(b.id));

for (const [name, rows] of Object.entries({ issues, pending: (backlog.pending || []).map((d) => ({ ...d, options_text: (d.options || []).join("\n") })), activity: backlog.activity || [], features: backlog.features || [], changes: backlog.changes, runs: backlog.runs.map((r) => ({ ...r, result_es: es(r.result) })) })) {
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(rows, null, 2));
  console.log(`${name}.json: ${rows.length} rows`);
}
