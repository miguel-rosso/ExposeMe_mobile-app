import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { Linking, Text } from "react-native";
import { checkGalleryAccess, GalleryPermission, PHOTO_QUERY_TIMEOUT_MS } from "../src/utils/galleryAccess";
import GalleryAccessModal from "../src/components/modals/GalleryAccessModal";
import { TEST_IDS } from "../src/utils/testIds";
import en from "../src/i18n/en";
import es from "../src/i18n/es";

// EXP-118: playing needs photo permission (full or limited access) and at least one photo visible to the app.

jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));

const perm = (status: string, accessPrivileges?: "all" | "limited" | "none", canAskAgain = true): GalleryPermission => ({
  status, accessPrivileges, canAskAgain,
});
const deps = (current: GalleryPermission, afterPrompt: GalleryPermission = current, photos = true) => ({
  getPermissions: jest.fn(async () => current),
  requestPermissions: jest.fn(async () => afterPrompt),
  hasPhotos: jest.fn(async () => photos),
});

describe("checkGalleryAccess", () => {
  it("full access with photos: ok, without prompting", async () => {
    const d = deps(perm("granted", "all"));
    await expect(checkGalleryAccess(d, { ask: true })).resolves.toEqual({ status: "ok", limited: false, canAskAgain: true });
    expect(d.requestPermissions).not.toHaveBeenCalled();
  });

  it("limited access with at least one visible photo counts as permission", async () => {
    const d = deps(perm("granted", "limited"));
    await expect(checkGalleryAccess(d, { ask: true })).resolves.toEqual({ status: "ok", limited: true, canAskAgain: true });
  });

  it("limited access with nothing selected: no-photos (limited)", async () => {
    const d = deps(perm("granted", "limited"), undefined, false);
    await expect(checkGalleryAccess(d, { ask: true })).resolves.toEqual({ status: "no-photos", limited: true, canAskAgain: true });
  });

  it("full access but an empty gallery: no-photos", async () => {
    const d = deps(perm("granted", "all"), undefined, false);
    await expect(checkGalleryAccess(d, { ask: false })).resolves.toMatchObject({ status: "no-photos", limited: false });
  });

  it("denied for good: denied, no prompt and no photo query", async () => {
    const d = deps(perm("denied", "none", false));
    await expect(checkGalleryAccess(d, { ask: true })).resolves.toEqual({ status: "denied", limited: false, canAskAgain: false });
    expect(d.requestPermissions).not.toHaveBeenCalled();
    expect(d.hasPhotos).not.toHaveBeenCalled();
  });

  it("undetermined: asks once when allowed to, and uses the answer", async () => {
    const d = deps(perm("undetermined", "none"), perm("granted", "limited"));
    await expect(checkGalleryAccess(d, { ask: true })).resolves.toMatchObject({ status: "ok", limited: true });
    expect(d.requestPermissions).toHaveBeenCalledTimes(1);

    const refused = deps(perm("undetermined", "none"), perm("denied", "none", false));
    await expect(checkGalleryAccess(refused, { ask: true })).resolves.toMatchObject({ status: "denied", canAskAgain: false });
    expect(refused.requestPermissions).toHaveBeenCalledTimes(1);
  });

  it("without ask (foreground re-check) it never prompts", async () => {
    const d = deps(perm("undetermined", "none"), perm("granted", "all"));
    await expect(checkGalleryAccess(d, { ask: false })).resolves.toMatchObject({ status: "denied", canAskAgain: true });
    expect(d.requestPermissions).not.toHaveBeenCalled();
  });

  // EXP-136: the photo query never answered after the permission was changed while the app ran, so Create did nothing
  describe("photo query that never answers", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("reports the gallery as unavailable once the timeout runs out, instead of hanging", async () => {
      const d = { ...deps(perm("granted", "limited")), hasPhotos: jest.fn(() => new Promise<boolean>(() => {})) };
      const settled = jest.fn();
      checkGalleryAccess(d, { ask: true }).then(settled);
      await jest.advanceTimersByTimeAsync(PHOTO_QUERY_TIMEOUT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledWith({ status: "unavailable", limited: true, canAskAgain: true });
    });

    it("a query that answers in time keeps its answer and leaves no timer behind", async () => {
      const d = deps(perm("granted", "all"));
      await expect(checkGalleryAccess(d, { ask: false })).resolves.toMatchObject({ status: "ok" });
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});

describe("GalleryAccessModal", () => {
  const has = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true }).length > 0;
  const press = (root: ReactTestInstance, id: string) =>
    act(() => { root.find((n) => n.props.testID === id && typeof n.props.onPress === "function").props.onPress(); });
  const render = (props: Partial<React.ComponentProps<typeof GalleryAccessModal>>) => {
    const handlers = { onAllow: jest.fn(), onSelectPhotos: jest.fn(), onRetry: jest.fn() };
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<GalleryAccessModal access={null} {...handlers} {...props} />); });
    return { r, ...handlers };
  };

  it("hidden when there is nothing missing", () => {
    expect(has(render({ access: null }).r.root, TEST_IDS.galleryAccessModal)).toBe(false);
    expect(has(render({ access: { status: "ok", limited: false, canAskAgain: true } }).r.root, TEST_IDS.galleryAccessModal)).toBe(false);
  });

  it("denied but promptable: allow button re-asks", () => {
    const { r, onAllow } = render({ access: { status: "denied", limited: false, canAskAgain: true } });
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(true);
    press(r.root, TEST_IDS.galleryAllowButton);
    expect(onAllow).toHaveBeenCalled();
  });

  it("denied for good: only Settings (and the guide on home)", () => {
    const spy = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
    const onShowHelp = jest.fn();
    const { r } = render({ access: { status: "denied", limited: false, canAskAgain: false }, onShowHelp });
    expect(has(r.root, TEST_IDS.galleryAllowButton)).toBe(false);
    press(r.root, TEST_IDS.gallerySettingsButton);
    expect(spy).toHaveBeenCalled();
    press(r.root, TEST_IDS.galleryHelpButton);
    expect(onShowHelp).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("limited with no photo: offers to select more photos", () => {
    const { r, onSelectPhotos } = render({ access: { status: "no-photos", limited: true, canAskAgain: true } });
    expect(r.root.findByProps({ testID: TEST_IDS.galleryAccessMessage }).props.children).toBe(en.galleryNoPhotosLimited);
    press(r.root, TEST_IDS.gallerySelectPhotosButton);
    expect(onSelectPhotos).toHaveBeenCalled();
  });

  it("empty gallery: says at least one photo is needed", () => {
    const { r, onRetry } = render({ access: { status: "no-photos", limited: false, canAskAgain: true } });
    expect(r.root.findByProps({ testID: TEST_IDS.galleryAccessMessage }).props.children).toBe(en.galleryNoPhotos);
    press(r.root, TEST_IDS.galleryRetryButton);
    expect(onRetry).toHaveBeenCalled();
  });

  // EXP-136: a photo query that timed out is not "no photos": no Select photos / Settings, only Try again
  it("gallery unavailable (even with limited access): says it couldn't be read and only offers Try again", () => {
    const { r, onRetry } = render({ access: { status: "unavailable", limited: true, canAskAgain: true }, blocking: true });
    expect(r.root.findByProps({ testID: TEST_IDS.galleryAccessMessage }).props.children).toBe(en.galleryUnavailable);
    expect(has(r.root, TEST_IDS.gallerySelectPhotosButton)).toBe(false);
    expect(has(r.root, TEST_IDS.gallerySettingsButton)).toBe(false);
    expect(has(r.root, TEST_IDS.galleryAllowButton)).toBe(false);
    expect(r.root.findAllByType(Text).some((n) => n.props.children === en.galleryBlockedNote)).toBe(false);
    press(r.root, TEST_IDS.galleryRetryButton);
    expect(onRetry).toHaveBeenCalled();
  });

  it("every gate text is translated in en and es", () => {
    const keys = ["galleryAccessTitle", "galleryAccessDenied", "galleryNoPhotosTitle", "galleryNoPhotos", "galleryNoPhotosLimited",
      "galleryUnavailableTitle", "galleryUnavailable", "galleryBlockedNote", "allowAccess", "selectPhotos", "tryAgain", "howToEnable"] as const;
    for (const k of keys) {
      expect(en[k]).toBeTruthy();
      expect(es[k]).toBeTruthy();
      expect(es[k]).not.toBe(en[k]);
    }
  });

  it("onboarding / settings texts no longer demand full access", () => {
    for (const t of [en, es]) {
      expect(t.fullAccessExplanation).not.toMatch(/full access|acceso completo/i);
      expect(t.alwaysAllowAll).not.toMatch(/allow all|permitir.*todo/i);
    }
  });
});
