/**
 * @jest-environment node
 */
// Guards against half-done upgrades (EXP-421): every package the installed `expo` pins in its bundledNativeModules
// must be installed at a version in that range. A lagging react-native, expo-router or native module ships known
// release crashes, and Expo's precompiled iOS binaries are rebuilt against each react-native patch. Fix a failure
// with `npx expo install --fix`.
// This only compares node_modules with the installed `expo`, offline; it can't tell whether newer SDK patches are
// out. Freshness against upstream still needs the online `npx expo install --check` / `npx expo-doctor`.
import fs from "fs";
import path from "path";
import pkg from "../package.json";

// The versions this Expo SDK release expects, keyed by package name (what `expo install` resolves against offline).
import sdkVersions from "expo/bundledNativeModules.json";

// semver ships with the Expo CLI toolchain (no type package installed); `satisfies` is all this check needs.
const semver: { satisfies: (version: string, range: string) => boolean } = require("semver");

const NODE_MODULES = path.resolve(__dirname, "../node_modules");

const installedVersionOf = (name: string): string =>
  JSON.parse(fs.readFileSync(path.join(NODE_MODULES, name, "package.json"), "utf8")).version;

const expectedRanges = sdkVersions as Record<string, string>;
const sdkManagedPackages = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)].filter(
  (name) => name in expectedRanges
);

describe("Expo SDK alignment (EXP-421)", () => {
  it("checks the packages the SDK manages", () => {
    // Guards against the lookup silently matching nothing (e.g. if the SDK moves the version table).
    expect(sdkManagedPackages).toEqual(expect.arrayContaining(["react-native", "expo-router", "react-native-screens"]));
  });

  it("installs every SDK-managed package at the version the SDK expects", () => {
    const misaligned = sdkManagedPackages
      .map((name) => ({ name, installed: installedVersionOf(name), expected: expectedRanges[name] }))
      .filter(({ installed, expected }) => !semver.satisfies(installed, expected))
      .map(({ name, installed, expected }) => `${name}@${installed} (expected ${expected})`);
    expect(misaligned).toEqual([]);
  });
});
