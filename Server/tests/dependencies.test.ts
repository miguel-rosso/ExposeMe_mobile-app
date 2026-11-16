import fs from "fs";
import { createRequire } from "module";
import path from "path";
import { describe, expect, it } from "vitest";

// Every runtime dependency must be imported by the server code (EXP-052): unused ones end up in the production install.

const SERVER_ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, "package.json"), "utf8"));
const NOT_SERVER_CODE = new Set(["node_modules", "tests", "dist", "temp"]);
const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\s+|\brequire\(\s*|\bimport\(\s*)["']([^"'.][^"']*)["']/g;

const listServerSources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return NOT_SERVER_CODE.has(entry.name) ? [] : listServerSources(file);
    return /\.ts$/.test(entry.name) ? [file] : [];
  });

/** "@scope/name/sub/path" -> "@scope/name", "name/sub" -> "name" */
const packageOf = (specifier: string) =>
  specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

/** Lowest multer release whose multipart parsing is safe to expose (EXP-439); npm audit skips its prereleases */
const MIN_MULTER_VERSION = [2, 5, 0];

/** Lowest vitest release whose worker pool and mocker are clear of the tinypool / @vitest/mocker advisories (EXP-241) */
const MIN_VITEST_VERSION = [4, 1, 12];

/** "2.5.0" -> [2, 5, 0] (a prerelease tag such as "-lts.1" is dropped) */
const versionParts = (version: string) => version.split("-")[0].split(".").map(Number);

const isAtLeast = (version: number[], min: number[]) => {
  const diff = version.map((part, i) => part - min[i]).find((d) => d !== 0);
  return diff === undefined || diff > 0;
};

/** Version of `name` as resolved from `fromDir`, following node_modules nesting */
const installedVersion = (name: string, fromDir: string): string => {
  const manifest = createRequire(path.join(fromDir, "package.json")).resolve(`${name}/package.json`);
  return JSON.parse(fs.readFileSync(manifest, "utf8")).version;
};

const isInstalled = (name: string) => fs.existsSync(path.join(SERVER_ROOT, "node_modules", name));

const importedPackages = new Set(
  listServerSources(SERVER_ROOT).flatMap((file) =>
    [...fs.readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER)].map((match) => packageOf(match[1]))
  )
);

describe("server dependencies (EXP-052)", () => {
  it("imports every runtime dependency", () => {
    const unused = Object.keys(pkg.dependencies).filter((name) => !importedPackages.has(name));
    expect(unused).toEqual([]);
  });

  it("only installs type packages for runtime dependencies", () => {
    const orphanTypes = Object.keys(pkg.devDependencies)
      .filter((name) => name.startsWith("@types/"))
      .filter((name) => !(name.slice("@types/".length) in pkg.dependencies));
    expect(orphanTypes).toEqual([]);
  });

  it("installs a multer release with the multipart parsing fixes (EXP-439)", () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, "node_modules/multer/package.json"), "utf8"));
    expect(isAtLeast(versionParts(version), MIN_MULTER_VERSION), `installed multer ${version}`).toBe(true);
  });

  it("installs a vitest release without the tinypool / @vitest/mocker advisories (EXP-241)", () => {
    const vitestVersion = installedVersion("vitest", SERVER_ROOT);
    const vitestDir = path.join(SERVER_ROOT, "node_modules/vitest");
    const mockerVersion = installedVersion("@vitest/mocker", vitestDir);
    expect(isAtLeast(versionParts(vitestVersion), MIN_VITEST_VERSION), `installed vitest ${vitestVersion}`).toBe(true);
    expect(isAtLeast(versionParts(mockerVersion), MIN_VITEST_VERSION), `installed @vitest/mocker ${mockerVersion}`).toBe(true);
    expect(isInstalled("tinypool"), "tinypool is installed").toBe(false);
  });
});
