/**
 * @jest-environment node
 */
// The app registers its own deep link scheme (EXP-168): the server's /join/<code> invite page opens
// exposeme://screens/WaitingRoom?code=<CODE>, so the resolved native config must claim "exposeme", not a generic one.
import path from "path";
import { getPrebuildConfigAsync } from "@expo/prebuild-config";
import { compileModsAsync } from "@expo/config-plugins/build/plugins/mod-compiler";

const projectRoot = path.resolve(__dirname, "..");
const APP_SCHEME = "exposeme";

let exp: any;

beforeAll(async () => {
  const config = await getPrebuildConfigAsync(projectRoot, { platforms: ["ios"] });
  await compileModsAsync(config.exp, {
    projectRoot,
    introspect: true,
    platforms: ["ios"],
    assertMissingModProviders: false,
  });
  exp = config.exp;
}, 60000);

describe("deep link scheme (EXP-168)", () => {
  it("uses the app's own scheme", () => {
    expect(exp.scheme).toBe(APP_SCHEME);
  });

  it("registers it as an iOS URL scheme, without the generic myapp", () => {
    const schemes = (exp.ios.infoPlist.CFBundleURLTypes ?? []).flatMap((t: any) => t.CFBundleURLSchemes ?? []);
    expect(schemes).toContain(APP_SCHEME);
    expect(schemes).not.toContain("myapp");
  });
});
