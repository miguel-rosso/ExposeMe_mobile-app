// ── Expo dev client floating "Tools" button ──
// Debug builds of expo-dev-client draw a draggable floating button over every screen. It covers real
// controls (close X, language toggle, own-photo hint, Play again), so the app hides it on launch.
// The dev menu stays reachable via shake, three-finger long press or `m` in Metro.
import { requireOptionalNativeModule } from "expo";

const DEV_MENU_NATIVE_MODULE = "ExpoDevMenu";

export type DevMenuModule = { setToolsButtonVisible: (visible: boolean) => Promise<void> };

const loadDevMenuModule = () => requireOptionalNativeModule<DevMenuModule>(DEV_MENU_NATIVE_MODULE);

/**
 * No-op in release builds, where the dev menu native module is absent. Never rejects: on Android the
 * dev menu may not be initialized yet at module load, so callers retry once the first screen has rendered.
 */
export const hideDevToolsButton = async (
  isDev: boolean = __DEV__,
  loadModule: () => DevMenuModule | null = loadDevMenuModule,
): Promise<void> => {
  if (!isDev) return;
  try {
    await loadModule()?.setToolsButtonVisible(false);
  } catch (error) {
    console.warn("Could not hide the dev client Tools button yet:", error);
  }
};
