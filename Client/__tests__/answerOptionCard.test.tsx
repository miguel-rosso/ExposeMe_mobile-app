import React from "react";
import { AccessibilityInfo, Animated, StyleSheet } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import * as Haptics from "expo-haptics";
import AnswerOption, {
  ANSWER_STATE_BORDER, AnswerOptionState, ENTRANCE_MAX_DELAY_MS, ENTRANCE_MS, MARKED_SCALE, entranceDelay,
} from "../app/components/AnswerOption";
import {
  PLAYER_COLOR_INK, PLAYER_PALETTE, PlayerColors, playerColors, playerInitial, withPlayerColors,
} from "../app/utils/playerColors";
import { useReduceMotion } from "../app/hooks/useReduceMotion";
import { usePlayerColors } from "../app/hooks/usePlayerColors";
import { playerOptionId } from "../app/utils/testIds";

// EXP-253: the answer cards were flat grey blocks with just the name. Each player now has a colour and an initial,
// the cards are dark and translucent, and my pick is marked by its border, a check/cross badge and a short motion.

// The room cap (Server/managers/RoomManager.ts MAX_PLAYERS_PER_ROOM)
const MAX_PLAYERS = 12;

// WCAG relative luminance and contrast ratio of two #rrggbb colours
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// Bold initials: the WCAG minimum for large/bold text
const MIN_INITIAL_CONTRAST = 3;

describe("playerColors (EXP-253)", () => {
  const rooms = [
    Array.from({ length: MAX_PLAYERS }, (_, i) => `player${i + 1}`),
    Array.from({ length: MAX_PLAYERS }, (_, i) => `bot${i + 1}`),
    ["alice", "bob", "carol", "dave", "eve", "frank"],
    ["Miguel", "Lucía", "José", "María", "Ana", "Pablo", "Sofía", "Javi"],
    ["Mariacarmen_001", "Mariacarmen_002", "Mariacarmen_003"],
  ];

  it("gives every player of a room a different palette colour", () => {
    for (const names of rooms) {
      const colors = playerColors(names);
      expect(new Set(names.map((n) => colors.get(n))).size).toBe(names.length);
      for (const n of names) expect(PLAYER_PALETTE).toContain(colors.get(n));
    }
  });

  it("is the same on every device: it depends on the names, not on their order", () => {
    for (const names of rooms) {
      expect(playerColors([...names].reverse())).toEqual(playerColors(names));
      expect(playerColors(names)).toEqual(playerColors(names));
    }
  });

  it("counts a repeated name once", () => {
    expect([...playerColors(["alice", "alice"]).keys()]).toEqual(["alice"]);
  });

  it("draws readable initials on every palette colour", () => {
    for (const color of PLAYER_PALETTE) expect(contrast(color, PLAYER_COLOR_INK)).toBeGreaterThanOrEqual(MIN_INITIAL_CONTRAST);
  });

  // Fixed for the whole game: someone leaving must not hand their colour (or a shuffle) to the others
  it("keeps every colour given, and reserves a leaver's, as players come and go", () => {
    const start = playerColors(rooms[2]);
    const [, leaver, ...stay] = rooms[2];
    expect(withPlayerColors(start, rooms[2].filter((n) => n !== leaver))).toBe(start);
    const later = withPlayerColors(start, [...stay, "alice", "zoe"]);
    for (const name of rooms[2]) expect(later.get(name)).toBe(start.get(name));
    expect([...start.values()]).not.toContain(later.get("zoe"));
  });

  // Grapheme samples, written as escapes: a flag, a ZWJ family, a decomposed accent, and a letter whose upper case is
  // two letters
  const FLAG_ES = "\u{1F1EA}\u{1F1F8}";
  const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  const E_ACUTE_DECOMPOSED = "e\u0301";
  const SHARP_S = "\u00DF";
  const initialCases: [string, string][] = [
    ["alice", "A"],
    ["  bob", "B"],
    ["\u{1F600}party", "\u{1F600}"],
    [`${FLAG_ES}Pepe`, FLAG_ES],
    [`${FAMILY}x`, FAMILY],
    [`${E_ACUTE_DECOMPOSED}lena`, "E\u0301"],
    [`${SHARP_S}eta`, SHARP_S],
    ["", "?"],
  ];

  it.each(initialCases)("takes the first whole character of %j as the initial: %j", (name, initial) => {
    expect(playerInitial(name)).toBe(initial);
  });

  // Hermes has no Intl.Segmenter: the pattern fallback must give the same initials
  it.each(initialCases)("without Intl.Segmenter, %j still gives %j", (name, initial) => {
    const segmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter")!;
    Object.defineProperty(Intl, "Segmenter", { ...segmenter, value: undefined });
    try {
      expect(playerInitial(name)).toBe(initial);
    } finally {
      Object.defineProperty(Intl, "Segmenter", segmenter);
    }
  });

  // EXP-265: every card asks for its initial when it mounts, every round: one segmenter serves them all
  it("builds the grapheme segmenter once for all the initials", () => {
    const segmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter")!;
    const constructed = jest.fn();
    class CountedSegmenter extends Intl.Segmenter {
      constructor(...args: ConstructorParameters<typeof Intl.Segmenter>) {
        super(...args);
        constructed();
      }
    }
    Object.defineProperty(Intl, "Segmenter", { ...segmenter, value: CountedSegmenter });
    try {
      for (const [name, initial] of initialCases) expect(playerInitial(name)).toBe(initial);
      expect(constructed).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(Intl, "Segmenter", segmenter);
    }
  });
});

describe("usePlayerColors", () => {
  it("keeps the colours (and the map) while players leave, and only adds the new ones", () => {
    const seen: PlayerColors[] = [];
    const Probe = ({ names }: { names: string[] }) => {
      seen.push(usePlayerColors(names.map((username) => ({ username }))));
      return null;
    };
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<Probe names={["alice", "bob", "carol"]} />); });
    const first = seen.at(-1)!;
    act(() => r.update(<Probe names={["alice", "carol"]} />));
    expect(seen.at(-1)).toBe(first);
    act(() => r.update(<Probe names={["alice", "carol", "dave"]} />));
    const next = seen.at(-1)!;
    for (const name of ["alice", "bob", "carol"]) expect(next.get(name)).toBe(first.get(name));
    expect([...first.values()]).not.toContain(next.get("dave"));
    act(() => r.unmount());
  });
});

describe("useReduceMotion", () => {
  afterEach(() => jest.restoreAllMocks());

  it("starts from the system setting and follows its changes", async () => {
    let onChange: ((enabled: boolean) => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation(((_: string, fn: (enabled: boolean) => void) => {
      onChange = fn;
      return { remove };
    }) as unknown as typeof AccessibilityInfo.addEventListener);
    const seen: boolean[] = [];
    const Probe = () => { seen.push(useReduceMotion()); return null; };
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<Probe />); });
    expect(seen.at(-1)).toBe(true);
    act(() => onChange!(false));
    expect(seen.at(-1)).toBe(false);
    act(() => r.unmount());
    expect(remove).toHaveBeenCalled();
  });
});

describe("AnswerOption (EXP-253)", () => {
  const BASE = {
    username: "alice", index: 0, color: PLAYER_PALETTE[0], isMe: false, youLabel: "You", columns: 2 as const,
    compact: false, disabled: false, animate: true, onPick: jest.fn(),
  };
  let r: TestRenderer.ReactTestRenderer;
  const render = (props: Partial<typeof BASE> & { state: AnswerOptionState }) =>
    act(() => { r = TestRenderer.create(<AnswerOption {...BASE} {...props} />); });
  const update = (props: Partial<typeof BASE> & { state: AnswerOptionState }) =>
    act(() => r.update(<AnswerOption {...BASE} {...props} />));
  const card = () => r.root.find((n) => n.props.testID === playerOptionId("alice") && typeof n.type === "string");
  const pressable = () => r.root.find((n) => n.props.testID === playerOptionId("alice") && typeof n.props.onPress === "function");
  const cell = () => r.root.findAll((n) => typeof n.type === "string")[0];
  const texts = () => r.root.findAll((n) => (n.type as unknown) === "Text").map((n) => [n.props.children].flat().join(""));
  const style = (n: ReactTestInstance) => StyleSheet.flatten(n.props.style);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Haptics, "impactAsync").mockResolvedValue();
  });
  afterEach(() => {
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("shows the player's colour and initial; an unpicked card has only the thin light border", () => {
    render({ state: "idle" });
    const avatar = r.root.findAll((n) => typeof n.type === "string" && style(n)?.backgroundColor === PLAYER_PALETTE[0]);
    expect(avatar).toHaveLength(1);
    expect(texts()).toEqual(["A", "alice"]);
    expect(style(card()).borderColor).toBe(ANSWER_STATE_BORDER.idle);
    expect(card().props.accessibilityState).toMatchObject({ selected: false });
  });

  it.each([
    ["selected", "✓"],
    ["correct", "✓"],
    ["wrong", "✕"],
  ] as const)("marks my %s pick with its border colour and a %s badge", (state, mark) => {
    render({ state });
    expect(style(card()).borderColor).toBe(ANSWER_STATE_BORDER[state]);
    expect(texts()).toContain(mark);
    expect(card().props.accessibilityState).toMatchObject({ selected: true });
  });

  it("gives every state its own border", () => {
    expect(new Set(Object.values(ANSWER_STATE_BORDER)).size).toBe(4);
  });

  it("a tapped card dims only slightly, not to TouchableOpacity's near-transparent default", () => {
    render({ state: "idle" });
    expect(pressable().props.activeOpacity).toBeGreaterThanOrEqual(0.6);
  });

  it("vibrates lightly on a new pick, not when tapping the card already picked", () => {
    const onPick = jest.fn();
    render({ state: "idle", onPick });
    act(() => pressable().props.onPress());
    expect(onPick).toHaveBeenCalledWith("alice");
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
    update({ state: "selected", onPick });
    act(() => pressable().props.onPress());
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
  });

  it("fades and rises in, staggered by its place in the list", () => {
    const timing = jest.spyOn(Animated, "timing");
    render({ state: "idle", index: 3 });
    expect(style(cell()).opacity).toBe(0);
    expect(timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toValue: 1, delay: entranceDelay(3) }));
  });

  it("the whole entrance of a full room lasts under 250 ms", () => {
    expect(entranceDelay(MAX_PLAYERS - 1) + ENTRANCE_MS).toBeLessThan(250);
    expect(entranceDelay(100)).toBe(ENTRANCE_MAX_DELAY_MS);
  });

  it("springs a new pick up to its marked scale", () => {
    const spring = jest.spyOn(Animated, "spring");
    render({ state: "idle" });
    update({ state: "selected" });
    expect(spring).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toValue: MARKED_SCALE }));
  });

  it("builds its animated style once: re-renders create no new interpolation nodes", () => {
    const interpolate = jest.spyOn(Animated.Value.prototype, "interpolate");
    render({ state: "idle" });
    const motion = style(cell()).transform;
    update({ state: "selected" });
    update({ state: "selected", disabled: true });
    expect(interpolate).toHaveBeenCalledTimes(1);
    expect(style(cell()).transform).toHaveLength(motion.length);
  });

  // EXP-265: TouchableOpacity animates its opacity whenever its `disabled` prop flips, on every card as answers close
  it("a disabled card takes no pick and says so, without animating its touch layer", () => {
    const onPick = jest.fn();
    render({ state: "idle", onPick });
    const timing = jest.spyOn(Animated, "timing");
    update({ state: "idle", onPick, disabled: true });
    expect(timing).not.toHaveBeenCalled();
    expect(pressable().props.accessibilityState).toEqual({ selected: false, disabled: true });
    expect(pressable().props.focusable).toBe(false);
    act(() => pressable().props.onPress());
    expect(onPick).not.toHaveBeenCalled();
    update({ state: "idle", onPick, disabled: false });
    act(() => pressable().props.onPress());
    expect(onPick).toHaveBeenCalledWith("alice");
  });

  it("with reduce motion: shown at once, and state changes don't move", () => {
    const timing = jest.spyOn(Animated, "timing");
    const spring = jest.spyOn(Animated, "spring");
    render({ state: "idle", animate: false });
    expect(style(cell()).opacity).toBe(1);
    update({ state: "selected", animate: false });
    update({ state: "wrong", animate: false });
    expect(style(card()).borderColor).toBe(ANSWER_STATE_BORDER.wrong);
    expect(timing).not.toHaveBeenCalled();
    expect(spring).not.toHaveBeenCalled();
  });
});
