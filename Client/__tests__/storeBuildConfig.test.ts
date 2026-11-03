/**
 * @jest-environment node
 */
// Pins the store-build settings (EXP-428): EAS owns the build numbers, the user-facing version,
// and the iOS privacy manifest and export-compliance declaration App Store Connect asks for.
import path from "path";
import { getPrebuildConfigAsync } from "@expo/prebuild-config";
import { compileModsAsync } from "@expo/config-plugins/build/plugins/mod-compiler";
import { mergePrivacyInfo } from "@expo/config-plugins/build/ios/PrivacyInfo";
import appJson from "../app.json";
import easJson from "../eas.json";

const projectRoot = path.resolve(__dirname, "..");

// android.versionCode of the dev-client builds already installed on the lab devices.
const LAST_LOCAL_VERSION_CODE = 10;

const APP_FUNCTIONALITY = "NSPrivacyCollectedDataTypePurposeAppFunctionality";

// Gallery photos sent to the room, and the player's name + lobby chat messages.
const COLLECTED_DATA_TYPES = [
  "NSPrivacyCollectedDataTypePhotosorVideos",
  "NSPrivacyCollectedDataTypeOtherUserContent",
];

// React Native core's required-reason APIs. app.json only seeds these: on `pod install`,
// React Native's privacy-manifest aggregation (privacy_file_aggregation_enabled,
// react-native/scripts/cocoapods/privacy_manifest_utils.rb) merges every pod's own
// PrivacyInfo.xcprivacy into the app's, keeping the collected data types declared here.
const ACCESSED_API_REASONS: Record<string, string> = {
  NSPrivacyAccessedAPICategoryUserDefaults: "CA92.1",
  NSPrivacyAccessedAPICategorySystemBootTime: "35F9.1",
  NSPrivacyAccessedAPICategoryFileTimestamp: "C617.1",
};

// First user-facing version of the store build prepared in EXP-428.
const MIN_STORE_VERSION = [1, 1, 0];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Negative, zero or positive as version `a` is lower than, equal to or higher than `b`. */
function compareVersions(a: number[], b: number[]): number {
  const index = a.findIndex((part, i) => part !== b[i]);
  return index === -1 ? 0 : a[index] - b[index];
}

let exp: any;

beforeAll(async () => {
  const config = await getPrebuildConfigAsync(projectRoot, { platforms: ["ios", "android"] });
  await compileModsAsync(config.exp, {
    projectRoot,
    introspect: true,
    platforms: ["ios", "android"],
    assertMissingModProviders: false,
  });
  exp = config.exp;
}, 60000);

describe("EAS build numbers (EXP-428)", () => {
  it("lets EAS store and bump the build numbers on production builds", () => {
    expect(easJson.cli.appVersionSource).toBe("remote");
    expect(easJson.build.production.autoIncrement).toBe(true);
  });

  it("keeps the other profiles' build numbers as they are", () => {
    const { production, ...otherProfiles } = easJson.build;
    for (const profile of Object.values(otherProfiles)) {
      expect(profile).not.toHaveProperty("autoIncrement");
    }
  });

  it("keeps the local Android versionCode for non-EAS builds", () => {
    // EAS ignores it with the remote source (it only seeds the remote counter), but `expo prebuild`
    // still writes it: dropping it would rebuild the lab dev clients as versionCode 1, and
    // `adb install -r` refuses that downgrade over the installed versionCode 10 build.
    expect(appJson.expo.android.versionCode).toBeGreaterThanOrEqual(LAST_LOCAL_VERSION_CODE);
  });

  it("ships a semver version of at least 1.1.0", () => {
    const parts = appJson.expo.version.match(SEMVER)?.slice(1).map(Number);
    expect(parts).toBeDefined();
    expect(compareVersions(parts!, MIN_STORE_VERSION)).toBeGreaterThanOrEqual(0);
  });
});

describe("iOS store declarations (EXP-428)", () => {
  it("declares that the app only uses exempt (OS-provided HTTPS/WSS) encryption", () => {
    expect(exp.ios.config.usesNonExemptEncryption).toBe(false);
    expect(exp.ios.infoPlist.ITSAppUsesNonExemptEncryption).toBe(false);
  });

  it("keeps iPad support", () => {
    expect(exp.ios.supportsTablet).toBe(true);
  });

  it("declares photos and user content as unlinked, untracked app-functionality data", () => {
    const manifest = exp.ios.privacyManifests;
    expect(manifest.NSPrivacyTracking).toBe(false);
    expect(manifest.NSPrivacyCollectedDataTypes).toEqual(
      COLLECTED_DATA_TYPES.map((type) => ({
        NSPrivacyCollectedDataType: type,
        NSPrivacyCollectedDataTypeLinked: false,
        NSPrivacyCollectedDataTypeTracking: false,
        NSPrivacyCollectedDataTypePurposes: [APP_FUNCTIONALITY],
      }))
    );
  });

  it("keeps the required-reason API declarations of the generated manifest", () => {
    const generated = {
      NSPrivacyAccessedAPITypes: Object.entries(ACCESSED_API_REASONS).map(([type, reason]) => ({
        NSPrivacyAccessedAPIType: type,
        NSPrivacyAccessedAPITypeReasons: [reason],
      })),
      NSPrivacyCollectedDataTypes: [],
      NSPrivacyTracking: false,
    };

    expect(exp.ios.privacyManifests.NSPrivacyAccessedAPITypes).toEqual(generated.NSPrivacyAccessedAPITypes);

    // Prebuild merges app.json into the existing PrivacyInfo.xcprivacy instead of replacing it.
    const merged = mergePrivacyInfo(generated, exp.ios.privacyManifests);

    expect(merged.NSPrivacyAccessedAPITypes).toEqual(generated.NSPrivacyAccessedAPITypes);
    expect(merged.NSPrivacyCollectedDataTypes.map((t: any) => t.NSPrivacyCollectedDataType)).toEqual(
      COLLECTED_DATA_TYPES
    );
    expect(merged.NSPrivacyTracking).toBe(false);
  });
});
