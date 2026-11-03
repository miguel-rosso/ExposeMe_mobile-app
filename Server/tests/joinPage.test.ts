import { describe, expect, it, vi } from "vitest";
import { parseAppStoreId, pickInviteLanguage, platformOf, renderJoinPage } from "../routes/joinPage";

// EXP-420: the invite page's pure parts. The route only ever passes valid room codes, but the page escapes the code
// on its own, so a looser caller can't turn it into markup or script.

const page = (code: string) => renderJoinPage({ code, language: "en", platform: "desktop", appStoreId: null, nonce: "abc" });

describe("renderJoinPage", () => {
  it("escapes the code in the text, the link and the script", () => {
    const html = page(`x"'<b>y</b></script>`);
    expect(html).not.toContain("<b>y</b>");
    expect(html).not.toContain(`x"'`);
    expect(html).toContain('<div class="code">x&quot;&#39;&lt;b&gt;y&lt;/b&gt;&lt;/script&gt;</div>');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it("links the App Store only with an id", () => {
    const withId = renderJoinPage({ code: "K7MQ4X", language: "en", platform: "ios", appStoreId: "123", nonce: "n" });
    expect(withId).toContain('href="https://apps.apple.com/app/id123"');
    expect(page("K7MQ4X")).not.toContain("apps.apple.com");
  });
});

describe("parseAppStoreId", () => {
  it("accepts a numeric id, trimmed", () => {
    expect(parseAppStoreId(" 6739012345 ")).toBe("6739012345");
  });

  it.each([undefined, "", "  "])("unset (%j) → null", (raw) => {
    expect(parseAppStoreId(raw)).toBeNull();
  });

  it.each(["id6739012345", "123abc", `1"><script>`])("non-numeric %j → null, logged", (raw) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseAppStoreId(raw)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("pickInviteLanguage", () => {
  it.each([["es", "es"], ["en", "en"], [false, "en"]] as const)("%j → %s", (accepted, language) => {
    expect(pickInviteLanguage(accepted)).toBe(language);
  });
});

describe("platformOf", () => {
  it.each([
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36", "android"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", "ios"],
    ["Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", "ios"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", "desktop"],
    [undefined, "desktop"],
  ] as const)("%s → %s", (userAgent, platform) => {
    expect(platformOf(userAgent)).toBe(platform);
  });
});
