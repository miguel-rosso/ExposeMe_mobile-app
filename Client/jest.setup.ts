// ── Node clearImmediate guard ──
// Node's clearImmediate trusts its argument: given anything that is not one of its own Immediates (e.g. a
// @sinonjs/fake-timers handle left over from jest.useFakeTimers()) it still decrements the process-wide count of
// pending immediates. With that count off by one, the next real setImmediate never runs, so React's act() (which
// waits on one) and Jest's own end-of-file setImmediate hang: tests time out at random and whole runs stall. This
// count is shared by every test file the worker runs afterwards.
// React Native's StatusBar keeps its pending update in a static field, so a handle scheduled under fake timers is
// cleared by the real clearImmediate as soon as a later test renders a StatusBar on real timers.
// Only real Immediates reach Node; any other handle belongs to a fake clock that is gone, so there is nothing to clear.

const probe = setImmediate(() => {});
const NodeImmediate = probe.constructor;
clearImmediate(probe);

const nodeClearImmediate = globalThis.clearImmediate;

globalThis.clearImmediate = ((handle?: NodeJS.Immediate) => {
  if (handle instanceof NodeImmediate) nodeClearImmediate(handle);
}) as typeof clearImmediate;

// ── Safe area ──
// Screens read the safe-area insets (notch, home indicator…), which the app's root provider supplies at runtime.
// The library's own mock gives zero insets without a provider (a device without notch); a test can still wrap a
// screen in its SafeAreaProvider with initialMetrics to set other insets.
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default);
