import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterAll, describe, expect, it, vi } from "vitest";
import { findServerRoot } from "../middlewares/upload";

// middlewares/upload creates its directory on load: point it at a throwaway one (set before the import above runs)
const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-build-test-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  return dir;
});

// Guards the production build: `npm run build` compiles with tsconfig.build.json and `npm run start:compiled` runs the
// compiled entry with plain node (no ts-node in production, see README "Deploy").

const SERVER_ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, "package.json"), "utf8"));
const BUILD_CONFIG = "tsconfig.build.json";
const OUT_DIR = "dist";
const TSC = path.join(SERVER_ROOT, "node_modules", "typescript", "bin", "tsc");
const BUILD_TIMEOUT_MS = 60_000;

describe("production build", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "exposeme-build-"));
  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  });

  it("build and start:compiled scripts use the build config and its compiled entry", () => {
    expect(pkg.scripts.build).toBe(`tsc -p ${BUILD_CONFIG}`);
    expect(pkg.scripts["start:compiled"]).toBe(`node ${OUT_DIR}/server.js`);
  });

  it(
    "compiles the server, without tests, so the start:compiled entry exists",
    () => {
      execFileSync(process.execPath, [TSC, "-p", BUILD_CONFIG, "--outDir", outDir], { cwd: SERVER_ROOT, stdio: "pipe" });
      const entry = path.relative(OUT_DIR, pkg.scripts["start:compiled"].replace(/^node /, ""));
      expect(fs.existsSync(path.join(outDir, entry))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "tests"))).toBe(false);
    },
    BUILD_TIMEOUT_MS,
  );

  it("resolves Server/ (and so Server/temp) from both the sources and the compiled output", () => {
    expect(findServerRoot(path.join(SERVER_ROOT, "middlewares"))).toBe(SERVER_ROOT);
    expect(findServerRoot(path.join(SERVER_ROOT, OUT_DIR, "middlewares"))).toBe(SERVER_ROOT);
  });
});
