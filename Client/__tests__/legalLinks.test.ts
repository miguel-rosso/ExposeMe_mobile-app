import { Linking } from "react-native";
import {
  contactEmail,
  contactMailtoUrl,
  openExternalLink,
  parseContactEmail,
  privacyPolicyUrl,
} from "../src/utils/legalLinks";

// EXP-426: the privacy policy is the game server's /privacy page in the app's language, and the contact address comes
// from the build's EXPO_PUBLIC_CONTACT_EMAIL (no address in the repo).

describe("privacyPolicyUrl", () => {
  const savedServer = process.env.EXPO_PUBLIC_SERVER_URL;
  afterEach(() => {
    if (savedServer === undefined) delete process.env.EXPO_PUBLIC_SERVER_URL;
    else process.env.EXPO_PUBLIC_SERVER_URL = savedServer;
  });

  it.each(["es", "en"] as const)("is the server's /privacy page with the app language (%s)", (lang) => {
    expect(privacyPolicyUrl(lang, "https://game.example")).toBe(`https://game.example/privacy?lang=${lang}`);
  });

  it("doesn't double the slash of a server URL that ends with one", () => {
    expect(privacyPolicyUrl("en", "http://localhost:3000/")).toBe("http://localhost:3000/privacy?lang=en");
  });

  it("defaults to the server the app plays on (EXPO_PUBLIC_SERVER_URL)", () => {
    process.env.EXPO_PUBLIC_SERVER_URL = "http://localhost:3999";
    expect(privacyPolicyUrl("es")).toBe("http://localhost:3999/privacy?lang=es");
  });
});

describe("contact address", () => {
  const savedEmail = process.env.EXPO_PUBLIC_CONTACT_EMAIL;
  afterEach(() => {
    if (savedEmail === undefined) delete process.env.EXPO_PUBLIC_CONTACT_EMAIL;
    else process.env.EXPO_PUBLIC_CONTACT_EMAIL = savedEmail;
  });

  it.each([undefined, "", "   ", "not-an-email", "a@b", "two words@example.com", `${"a".repeat(250)}@example.com`])(
    "ignores %p",
    (raw) => {
      expect(parseContactEmail(raw)).toBeNull();
    }
  );

  it("keeps a valid address, trimmed", () => {
    expect(parseContactEmail("  contact@example.com ")).toBe("contact@example.com");
  });

  it("reads EXPO_PUBLIC_CONTACT_EMAIL", () => {
    delete process.env.EXPO_PUBLIC_CONTACT_EMAIL;
    expect(contactEmail()).toBeNull();
    process.env.EXPO_PUBLIC_CONTACT_EMAIL = "contact@example.com";
    expect(contactEmail()).toBe("contact@example.com");
  });

  it("builds a mailto link", () => {
    expect(contactMailtoUrl("contact@example.com")).toBe("mailto:contact@example.com");
  });
});

describe("openExternalLink", () => {
  let openURL: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    openURL = jest.spyOn(Linking, "openURL");
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    openURL.mockRestore();
    warn.mockRestore();
  });

  it("opens the URL", async () => {
    openURL.mockResolvedValue(undefined);
    await expect(openExternalLink("https://game.example/privacy?lang=en")).resolves.toBe(true);
    expect(openURL).toHaveBeenCalledWith("https://game.example/privacy?lang=en");
  });

  it("reports false instead of throwing when no app can open it", async () => {
    openURL.mockRejectedValue(new Error("No Activity found to handle Intent"));
    await expect(openExternalLink("mailto:contact@example.com")).resolves.toBe(false);
  });
});
