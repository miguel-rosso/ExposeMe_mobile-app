import fs from "fs";
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
});
