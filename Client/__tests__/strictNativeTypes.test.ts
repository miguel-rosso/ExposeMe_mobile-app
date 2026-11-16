/**
 * @jest-environment node
 */
// The app type-checks against React Native's strict types (EXP-050): the `react-native-legacy-deep-imports` resolution
// condition kept the old hand-written types, which Expo drops after React Native 0.89. `npx tsc --noEmit` is the gate
// for the code itself; this keeps the condition from coming back to silence new errors.
import fs from "fs";
import path from "path";

const LEGACY_TYPES_CONDITION = "react-native-legacy-deep-imports";

interface TsConfig {
  extends?: string;
  compilerOptions?: { customConditions?: string[] };
}

const readTsConfig = (file: string): TsConfig => JSON.parse(fs.readFileSync(file, "utf8"));

const clientTsConfig = readTsConfig(path.resolve(__dirname, "../tsconfig.json"));
const expoBaseTsConfig = readTsConfig(require.resolve("expo/tsconfig.base.json"));

/** The resolution conditions tsc uses: the app's own override, or the ones it inherits from Expo's base config */
const effectiveCustomConditions = (): string[] =>
  clientTsConfig.compilerOptions?.customConditions ?? expoBaseTsConfig.compilerOptions?.customConditions ?? [];

describe("React Native strict types (EXP-050)", () => {
  it("extends Expo's base config", () => {
    expect(clientTsConfig.extends).toBe("expo/tsconfig.base");
  });

  it("resolves React Native's own types, not the legacy deep-import ones", () => {
    expect(effectiveCustomConditions()).toContain("react-native");
    expect(effectiveCustomConditions()).not.toContain(LEGACY_TYPES_CONDITION);
  });
});
