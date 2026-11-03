/**
 * @jest-environment node
 */
// Production bundles must not write game data (names, room codes, round answers) to the device log (EXP-419):
// babel.config.js strips console.log/info/debug from app code in production and keeps warn/error.
import path from "path";
import { transformSync } from "@babel/core";
// Plain CommonJS config: the plugin is defined inside it so Metro's cache key tracks it.
const { stripConsole } = require("../babel.config");

const projectRoot = path.resolve(__dirname, "..");
const APP_FILE = path.join(projectRoot, "app/screens/Example.tsx");
const DEPENDENCY_FILE = path.join(projectRoot, "node_modules/some-lib/index.js");

/** Runs only the plugin, without the Expo preset, so the output stays readable. */
function strip(code: string): string {
  return transformSync(code, { babelrc: false, configFile: false, plugins: [stripConsole] })!.code!;
}

/** Runs the project's babel.config.js the way Metro or jest would call it. */
function transformWithProjectConfig(code: string, caller: Record<string, unknown>, filename = APP_FILE, envName?: string): string {
  return transformSync(code, {
    filename,
    cwd: projectRoot,
    root: projectRoot,
    configFile: path.join(projectRoot, "babel.config.js"),
    babelrc: false,
    caller: { name: "metro", bundler: "metro", platform: "android", ...caller } as any,
    envName,
  })!.code!;
}

const SAMPLE = [
  'console.log("round-reveal", answer);',
  'console.info("joined", room);',
  'console.debug("state", state);',
  'console.warn("slow upload");',
  'console.error("upload failed");',
].join("\n");

describe("stripConsole plugin", () => {
  it("removes console.log/info/debug statements and keeps warn/error", () => {
    const out = strip(SAMPLE);
    expect(out).not.toMatch(/console\.(log|info|debug)/);
    expect(out).toContain('console.warn("slow upload")');
    expect(out).toContain('console.error("upload failed")');
  });

  it("replaces calls used as expressions with void 0", () => {
    expect(strip("cond && console.log(x);")).toBe("cond && void 0;");
    expect(strip("const f = () => console.info(x);")).toBe("const f = () => void 0;");
    expect(strip("const y = (console.debug(x), 1);")).toBe("const y = (void 0, 1);");
  });

  it("keeps if/else and loop bodies valid when their only statement is removed", () => {
    const out = strip('if (a) console.log(1); else console.log(2);\nfor (const p of list) console.log(p);');
    expect(out).not.toContain("console");
    expect(() => new Function(out)).not.toThrow();
  });

  it("strips the computed form console[\"log\"]", () => {
    expect(strip('console["log"](secret);')).toBe("");
  });

  it("leaves a local variable named console and references that are not calls alone", () => {
    const shadowed = "function f(console) { console.log(x); }";
    expect(strip(shadowed)).toContain("console.log(x)");
    expect(strip("promise.then(console.log);")).toContain("console.log");
  });

  it("strips the optional-call forms console?.log(x) and console.log?.(x), and keeps console.warn?.(x)", () => {
    expect(strip("console?.log(x);")).toBe("");
    expect(strip("console.info?.(x);")).toBe("");
    expect(strip("console?.debug?.(x);")).toBe("");
    expect(strip("cond && console?.log(x);")).toBe("cond && void 0;");
    expect(strip("const f = () => console.log?.(x);")).toBe("const f = () => void 0;");
    expect(strip("console.warn?.(x);")).toBe("console.warn?.(x);");
    expect(strip("console?.error(x);")).toBe("console?.error(x);");
  });
});

describe("babel.config.js", () => {
  const code = 'console.log("[GAME] round-reveal");\nconsole.error("[GAME] failed");';

  it("strips debug logs from app code in production Metro bundles (expo export, release builds)", () => {
    const out = transformWithProjectConfig(code, { isDev: false });
    expect(out).not.toContain("round-reveal");
    expect(out).toContain("[GAME] failed");
  });

  it("keeps them in Metro development bundles", () => {
    expect(transformWithProjectConfig(code, { isDev: true })).toContain("round-reveal");
  });

  it("keeps them in dependencies, even in production", () => {
    const out = transformWithProjectConfig(code, { isDev: false, isNodeModule: true }, DEPENDENCY_FILE);
    expect(out).toContain("round-reveal");
  });

  it("falls back to Babel's env name when the caller does not say (production strips, test keeps)", () => {
    const jestCaller = { name: "metro", bundler: "jest", platform: "ios" };
    expect(transformWithProjectConfig(code, jestCaller, APP_FILE, "production")).not.toContain("round-reveal");
    expect(transformWithProjectConfig(code, jestCaller, APP_FILE, "test")).toContain("round-reveal");
  });

  it("is the config jest runs with: tests still see console.log", () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    console.log("still here");
    expect(spy).toHaveBeenCalledWith("still here");
    spy.mockRestore();
  });
});
