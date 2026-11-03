import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// EXP-418: every environment variable the server reads is documented in Server/.env.example, and the file documents
// nothing the server no longer reads. Variables are found in the server sources (tests and build output excluded) as
// `process.env.NAME`, `process.env["NAME"]`, `env.NAME` (functions that take the env as a parameter) and the
// `envInt("NAME", …)` / `envMs("NAME", …)` helpers.

const SERVER_ROOT = path.resolve(__dirname, "..");
const ENV_EXAMPLE = path.join(SERVER_ROOT, ".env.example");
const SKIPPED_DIRS = new Set(["node_modules", "tests", "dist", "temp"]);

const ENV_READ_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
  /\benv\.([A-Z][A-Z0-9_]*)/g,
  /\benv(?:Int|Ms)\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
];
/** `NAME=value` lines of .env.example, active or commented out (`# NAME=value`). */
const DOCUMENTED_VAR = /^#?\s*([A-Z][A-Z0-9_]*)=/gm;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function varsReadByServer(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(SERVER_ROOT)) {
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of ENV_READ_PATTERNS) for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

const documentedVars = () => new Set([...fs.readFileSync(ENV_EXAMPLE, "utf8").matchAll(DOCUMENTED_VAR)].map((m) => m[1]));

describe("Server/.env.example", () => {
  it("finds the variables read in every style (the scan itself works)", () => {
    const read = varsReadByServer();
    for (const name of ["PORT", "ALLOWED_HOSTS", "RENDER", "ALLOW_QA_ROUNDS", "QA_TELEMETRY_FILE", "UPLOAD_INFLIGHT_MAX", "HTTP_REQUEST_TIMEOUT_MS"]) {
      expect(read).toContain(name);
    }
  });

  it("documents every variable the server reads", () => {
    const documented = documentedVars();
    expect([...varsReadByServer()].filter((name) => !documented.has(name)).sort()).toEqual([]);
  });

  it("documents only variables the server reads", () => {
    const read = varsReadByServer();
    expect([...documentedVars()].filter((name) => !read.has(name)).sort()).toEqual([]);
  });

  it("leaves the lab-only switches off", () => {
    const text = fs.readFileSync(ENV_EXAMPLE, "utf8");
    for (const name of ["ALLOW_QA_ROUNDS", "QA_TELEMETRY", "QA_TELEMETRY_FILE"]) {
      expect(text).not.toMatch(new RegExp(`^${name}=`, "m"));
    }
  });
});
