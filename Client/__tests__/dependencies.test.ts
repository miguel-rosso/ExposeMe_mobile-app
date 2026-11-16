/**
 * @jest-environment node
 */
// Every runtime dependency must be used by the app (EXP-052): unused ones add native modules to the build and make
// `npm audit` noisier.
import fs from "fs";
import path from "path";
import pkg from "../package.json";
import appJson from "../app.json";
import { listAppSources, clientRelative } from "../testUtils/appSources";

const CONFIG_FILE = path.join(__dirname, "../config.ts");

/** Dependencies the app needs without importing them, and why */
const INDIRECT_DEPENDENCIES: Record<string, string> = {
  "expo-linking": "required peer dependency of expo-router",
  "react-native-screens": "required peer dependency of expo-router (its native Stack)",
  "react-native-worklets": "required peer dependency of react-native-reanimated",
  "react-native-gesture-handler":
    "required peer of react-native-drawer-layout (an expo-router dependency): npm installs and autolinks it anyway, so pin its SDK version here",
  "expo-status-bar": "native module expo-router renders the status bar through",
  "expo-system-ui": "applies app.json userInterfaceStyle on Android",
  "expo-dev-client": "the dev builds the QA lab runs (`expo start --dev-client`)",
  "react-dom": "web target (`npm run web`)",
  "react-native-web": "web target (`npm run web`)",
};

const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\s+|\brequire\(\s*|\bimport\(\s*)["']([^"'.][^"']*)["']/g;

/** "@scope/name/sub/path" -> "@scope/name", "name/sub" -> "name" */
const packageOf = (specifier: string) =>
  specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

const importSpecifiersOf = (file: string) =>
  [...fs.readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER)].map((match) => match[1]);

const importsOf = (file: string) => importSpecifiersOf(file).map(packageOf);

/** Icon packages replaced by the per-set @react-native-vector-icons packages (EXP-053) */
const DEPRECATED_ICON_PACKAGES = ["@expo/vector-icons", "react-native-vector-icons", "@types/react-native-vector-icons"];

const ICON_SET_SCOPE = "@react-native-vector-icons/";

const sources = [...listAppSources(), CONFIG_FILE];
const importedPackages = new Set(sources.flatMap(importsOf));

const configPlugins = new Set(
  appJson.expo.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) as string)
);

const installedPackages = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]);

describe("client dependencies (EXP-052)", () => {
  it("uses every runtime dependency: imported, an app.json plugin, or a documented indirect need", () => {
    const unused = Object.keys(pkg.dependencies).filter(
      (name) => !importedPackages.has(name) && !configPlugins.has(name) && !(name in INDIRECT_DEPENDENCIES)
    );
    expect(unused).toEqual([]);
  });

  it("only lists indirect needs that are still dependencies and not imported directly", () => {
    for (const name of Object.keys(INDIRECT_DEPENDENCIES)) {
      expect(pkg.dependencies).toHaveProperty([name]);
      expect(importedPackages.has(name)).toBe(false);
    }
  });

  it("only installs type packages for packages the app has", () => {
    const orphanTypes = Object.keys(pkg.devDependencies)
      .filter((name) => name.startsWith("@types/"))
      .filter((name) => !installedPackages.has(name.slice("@types/".length)));
    expect(orphanTypes).toEqual([]);
  });

  it("draws icons with the @react-native-vector-icons packages only (EXP-053)", () => {
    // @expo/vector-icons is on its way to deprecation and react-native-vector-icons is deprecated; mixing either with
    // the @react-native-vector-icons packages can render the same font's glyphs as "?" or empty squares.
    const installed = DEPRECATED_ICON_PACKAGES.filter((name) => installedPackages.has(name));
    const offenders = sources.filter((file) => importsOf(file).some((name) => DEPRECATED_ICON_PACKAGES.includes(name)));
    expect(installed).toEqual([]);
    expect(offenders.map(clientRelative)).toEqual([]);
  });

  it("imports icon sets from their /static entry, with the set's config plugin registering its font", () => {
    // The /static entry leaves the font to the native build (autolinking copies it into the app); on iOS the set's
    // config plugin must also list it in UIAppFonts, or its glyphs render as "?".
    const iconImports = sources.flatMap((file) =>
      importSpecifiersOf(file)
        .filter((specifier) => specifier.startsWith(ICON_SET_SCOPE))
        .map((specifier) => ({ file: clientRelative(file), specifier }))
    );
    expect(iconImports.length).toBeGreaterThan(0);
    expect(iconImports.filter(({ specifier }) => !specifier.endsWith("/static"))).toEqual([]);
    const unregistered = [...new Set(iconImports.map(({ specifier }) => packageOf(specifier)))].filter(
      (name) => !configPlugins.has(name)
    );
    expect(unregistered).toEqual([]);
  });

  it("never imports @react-navigation directly: expo-router bundles its own copy", () => {
    // A separate @react-navigation install has its own navigation contexts, so hooks like useIsFocused imported from
    // it would not see expo-router's screens. Use the re-exports from "expo-router" instead.
    const offenders = sources.filter((file) => importsOf(file).some((name) => name.startsWith("@react-navigation/")));
    expect(offenders.map(clientRelative)).toEqual([]);
  });
});
