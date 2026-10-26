import { NativeModules } from "react-native";

type EndCallback = (result: { finished: boolean }) => void;
// A native timing animation is sent as its eased values, one per 60 fps frame
type NativeAnimationConfig = { type: string; frames?: number[] };
const FRAME_MS = 1000 / 60;
// The preset's own delay, kept for animations sent without frames (springs, decays)
const DEFAULT_NATIVE_ANIMATION_MS = 16;

const nativeAnimationMs = (config: NativeAnimationConfig) =>
  config.frames ? (config.frames.length - 1) * FRAME_MS : DEFAULT_NATIVE_ANIMATION_MS;

/**
 * The React Native jest preset ends every native-driven animation 16 ms after it starts, whatever its duration. This
 * makes each timing animation end after its own duration (on jest's clock, fake timers included), as on a device, for
 * tests of components that wait for one to finish (e.g. the round progress bar's onEnd). Call it in a beforeEach.
 */
export const honourNativeAnimationDurations = () => {
  (NativeModules.NativeAnimatedModule.startAnimatingNode as jest.Mock).mockImplementation(
    (_animationId: number, _nodeTag: number, config: NativeAnimationConfig, endCallback: EndCallback) => {
      setTimeout(() => endCallback({ finished: true }), nativeAnimationMs(config));
    },
  );
};
