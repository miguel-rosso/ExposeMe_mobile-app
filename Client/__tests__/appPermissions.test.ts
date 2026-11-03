/**
 * @jest-environment node
 */
// Resolves the Expo config the same way `npx expo config --type introspect` does
// (app.json + every auto/explicit config plugin), so a dependency bump that
// re-adds unused permissions or generic usage strings fails here (EXP-055/056).
import path from "path";
import { getPrebuildConfigAsync } from "@expo/prebuild-config";
import { compileModsAsync } from "@expo/config-plugins/build/plugins/mod-compiler";
import en from "../locales/en.json";
import es from "../locales/es.json";

const projectRoot = path.resolve(__dirname, "..");

const UNUSED_ANDROID_PERMISSIONS = [
  "android.permission.RECORD_AUDIO",
  "android.permission.CAMERA",
  "android.permission.READ_MEDIA_VIDEO",
  "android.permission.READ_MEDIA_AUDIO",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.ACCESS_MEDIA_LOCATION",
  "android.permission.SYSTEM_ALERT_WINDOW",
];

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

describe("app permissions (EXP-055)", () => {
  it("blocks every Android permission the app does not use", () => {
    expect(exp.android.blockedPermissions).toEqual(expect.arrayContaining(UNUSED_ANDROID_PERMISSIONS));
    for (const permission of UNUSED_ANDROID_PERMISSIONS) {
      expect(exp.android.permissions ?? []).not.toContain(permission);
    }
  });

  it("only requests photo read access on Android", () => {
    expect(exp.android.permissions).toEqual(
      expect.arrayContaining([
        "android.permission.READ_MEDIA_IMAGES",
        "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
        "android.permission.READ_EXTERNAL_STORAGE",
      ])
    );
  });

  it("keeps VIBRATE: the answer haptics (expo-haptics impactAsync) drive Android's Vibrator (EXP-091)", () => {
    expect(exp.android.blockedPermissions).not.toContain("android.permission.VIBRATE");
  });

  it("configures the media plugins for photos only", () => {
    const pluginOptions = (name: string) =>
      (exp.plugins as any[]).find((p) => Array.isArray(p) && p[0] === name)?.[1];

    expect(pluginOptions("expo-media-library")).toMatchObject({
      granularPermissions: ["photo"],
      savePhotosPermission: false,
      isAccessMediaLocationEnabled: false,
    });
    expect(pluginOptions("expo-image-picker")).toMatchObject({
      cameraPermission: false,
      microphonePermission: false,
    });
  });
});

describe("iOS usage strings (EXP-056)", () => {
  it("explains that gallery photos are shown to the other players", () => {
    const plist = exp.ios.infoPlist;
    expect(plist.NSPhotoLibraryUsageDescription).toBe(en.ios.NSPhotoLibraryUsageDescription);
    expect(plist.NSPhotoLibraryUsageDescription).toMatch(/other players/);
    expect(plist.NSPhotoLibraryUsageDescription).not.toMatch(/\$\(PRODUCT_NAME\)/);
  });

  it("drops camera, microphone and save-to-library usage strings", () => {
    const plist = exp.ios.infoPlist;
    expect(plist).not.toHaveProperty("NSCameraUsageDescription");
    expect(plist).not.toHaveProperty("NSMicrophoneUsageDescription");
    expect(plist).not.toHaveProperty("NSPhotoLibraryAddUsageDescription");
  });

  it("only shows the limited-library picker when the player asks for it (EXP-134)", () => {
    // Without this key iOS offers "Select More Photos / Keep Current Selection" on every launch
    // the first time the app reads the library; the app opens the picker from its own button.
    expect(exp.ios.infoPlist.PHPhotoLibraryPreventAutomaticLimitedAccessAlert).toBe(true);
  });

  it("ships a Spanish translation of the photo usage string", () => {
    expect(exp.locales).toEqual({ en: "./locales/en.json", es: "./locales/es.json" });
    expect(exp.ios.infoPlist.CFBundleAllowMixedLocalizations).toBe(true);
    expect(es.ios.NSPhotoLibraryUsageDescription).toMatch(/resto de jugadores/);
  });
});
