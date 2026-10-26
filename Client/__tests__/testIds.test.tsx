import React from "react";
import fs from "fs";
import path from "path";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import {
  TEST_IDS, playerOptionId, lobbyPlayerId, lobbyPlayerOfflineId, roundsOptionId, winnerNameId, finalWinnerId, finalRankId,
} from "../app/utils/testIds";
import AlertModal from "../app/components/modals/AlertModal";
import CloseButton from "../app/components/CloseButton";

// Icon fonts are not loadable under jest
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");

// Animatable schedules animation frames: keep them on fake timers and unmount after each render
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

const APP_DIR = path.join(__dirname, "../app");
const MAESTRO_DIR = path.join(__dirname, "../../qa/maestro");

const listSources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listSources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });

const hasTestID = (root: ReactTestInstance, id: string) =>
  root.findAll((n) => n.props.testID === id, { deep: true }).length > 0;

describe("E2E testIDs (EXP-008)", () => {
  it("builds per-player and per-option ids", () => {
    expect(playerOptionId("bot1")).toBe("player-option-bot1");
    expect(lobbyPlayerId("Ana")).toBe("lobby-player-Ana");
    expect(roundsOptionId(5)).toBe("rounds-option-5");
  });

  it("renders the alert modal ids", () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(
        <AlertModal visible title="t" message="m" onConfirm={jest.fn()} onCancel={jest.fn()} />
      );
    });
    expect(hasTestID(r.root, TEST_IDS.alertModal)).toBe(true);
    expect(hasTestID(r.root, TEST_IDS.alertModalConfirm)).toBe(true);
    expect(hasTestID(r.root, TEST_IDS.alertModalCancel)).toBe(true);
    act(() => r.unmount());
  });

  it("renders the close button id", () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(<CloseButton onPress={jest.fn()} />);
    });
    expect(hasTestID(r.root, TEST_IDS.closeButton)).toBe(true);
    act(() => r.unmount());
  });

  it("wires every registered id into a component", () => {
    const sources = listSources(APP_DIR)
      .filter((f) => !f.endsWith(path.join("utils", "testIds.ts")))
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    const unused = Object.keys(TEST_IDS).filter((k) => !sources.includes(`TEST_IDS.${k}`));
    expect(unused).toEqual([]);
    expect(sources).toContain("playerOptionId(item.username)");
    expect(sources).toContain("lobbyPlayerId(item.username)");
    expect(sources).toContain("lobbyPlayerOfflineId(item.username)");
    expect(sources).toContain("winnerNameId(w.username)");
    expect(sources).toContain("finalWinnerId(w.username)");
    expect(sources).toContain("finalRankId(item.username)");
  });

  it("only uses registered ids in Maestro flows", () => {
    const known = [
      ...Object.values(TEST_IDS),
      playerOptionId(".*"),
      playerOptionId("bot1"),
      lobbyPlayerId(".*"),
      // EXP-157 lobby-host-drop flow: the bot host's row
      lobbyPlayerId("bot1"),
      lobbyPlayerOfflineId("bot1"),
      // EXP-172 play-again-linger flow: nobody may show as offline, and a deliberate wait on an absent id
      lobbyPlayerOfflineId("bot2"),
      lobbyPlayerOfflineId("${USERNAME}"),
      "never-shown-linger-wait",
      roundsOptionId(0).replace("0", ".*"),
      // EXP-085 tie flow: the device user and a bot
      ...["${USERNAME}", "bot1"].flatMap((u) => [winnerNameId(u), finalWinnerId(u), finalRankId(u)]),
      // System photo picker and crop screen used by plant-photo.yaml (not our components)
      "com.google.android.providers.media.module:id/icon_thumbnail",
      "com.socketNull.ExposeMe:id/crop_image_menu_crop",
      "Done",
    ];
    const flows = fs.readdirSync(MAESTRO_DIR).filter((f) => f.endsWith(".yaml"));
    const used = flows.flatMap((f) =>
      [...fs.readFileSync(path.join(MAESTRO_DIR, f), "utf8").matchAll(/\bid:\s*"([^"]+)"/g)].flatMap((m) =>
        m[1].split("|")
      )
    );
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((id) => !known.includes(id))).toEqual([]);
  });
});
