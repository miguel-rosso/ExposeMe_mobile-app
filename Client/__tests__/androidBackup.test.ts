/**
 * @jest-environment node
 */
// The app keeps the player's name, language, rejoin token and accepted terms version on the
// phone only, as the privacy policy says: Android Auto Backup must not copy them to Google
// Drive and restore them on another device (EXP-436).
import path from "path";
import { getPrebuildConfigAsync } from "@expo/prebuild-config";
import { compileModsAsync } from "@expo/config-plugins/build/plugins/mod-compiler";
import appJson from "../app.json";

const projectRoot = path.resolve(__dirname, "..");

describe("Android app data backup (EXP-436)", () => {
  it("is turned off in app.json", () => {
    expect(appJson.expo.android.allowBackup).toBe(false);
  });

  it('writes android:allowBackup="false" into the generated AndroidManifest', async () => {
    const config = await getPrebuildConfigAsync(projectRoot, { platforms: ["android"] });
    const exp: any = await compileModsAsync(config.exp, {
      projectRoot,
      introspect: true,
      platforms: ["android"],
      assertMissingModProviders: false,
    });
    const manifest = exp._internal.modResults.android.manifest;
    expect(manifest.manifest.application[0].$["android:allowBackup"]).toBe("false");
  }, 60000);
});
