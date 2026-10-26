import { hideDevToolsButton } from "../app/utils/devToolsButton";

describe("dev client floating Tools button (EXP-200, EXP-142)", () => {
  it("hides the floating button in development builds so it never covers screen controls", async () => {
    const devMenu = { setToolsButtonVisible: jest.fn().mockResolvedValue(undefined) };
    await hideDevToolsButton(true, () => devMenu);
    expect(devMenu.setToolsButtonVisible).toHaveBeenCalledTimes(1);
    expect(devMenu.setToolsButtonVisible).toHaveBeenCalledWith(false);
  });

  it("does not touch the dev menu in release builds", async () => {
    const loadModule = jest.fn();
    await hideDevToolsButton(false, loadModule);
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("does not crash when the dev menu native module is missing", async () => {
    await expect(hideDevToolsButton(true, () => null)).resolves.toBeUndefined();
  });

  it("swallows a rejection from a not-yet-initialized dev menu so a later retry can hide it", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const devMenu = {
      setToolsButtonVisible: jest
        .fn()
        .mockRejectedValueOnce(new Error("Dev Menu is not initialized"))
        .mockResolvedValueOnce(undefined),
    };

    await expect(hideDevToolsButton(true, () => devMenu)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);

    await expect(hideDevToolsButton(true, () => devMenu)).resolves.toBeUndefined();
    expect(devMenu.setToolsButtonVisible).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("is safe to call with the real module resolver", async () => {
    await expect(hideDevToolsButton()).resolves.toBeUndefined();
  });
});
