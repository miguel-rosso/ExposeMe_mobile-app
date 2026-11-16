import React from "react";
import fs from "fs";
import path from "path";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import {
  TEST_IDS, playerOptionId, lobbyPlayerId, lobbyPlayerOfflineId, roundsOptionId, winnerNameId, finalWinnerId, finalRankId,
  scoreRankId, scoreRemoveId, settingsStepId, lobbyMuteId, scoreMuteId, reactionPillId, reportReasonId,
} from "../src/utils/testIds";
import AlertModal from "../src/components/modals/AlertModal";
import CloseButton from "../src/components/CloseButton";
import { listAppSources } from "../testUtils/appSources";

// Icon fonts are not loadable under jest
jest.mock("@react-native-vector-icons/fontawesome/static", () => "Icon");
// The close button names itself for screen readers in the UI language
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));

// Animatable schedules animation frames: keep them on fake timers and unmount after each render
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

const MAESTRO_DIR = path.join(__dirname, "../../qa/maestro");

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
    const sources = listAppSources()
      .filter((f) => !f.endsWith(path.join("utils", "testIds.ts")))
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    const unused = Object.keys(TEST_IDS).filter((k) => !sources.includes(`TEST_IDS.${k}`));
    expect(unused).toEqual([]);
    expect(sources).toContain("playerOptionId(username)");
    expect(sources).toContain("emojiButtonId(index)");
    expect(sources).toContain("lobbyPlayerId(item.username)");
    expect(sources).toContain("lobbyPlayerOfflineId(item.username)");
    expect(sources).toContain("winnerNameId(w.username)");
    expect(sources).toContain("finalWinnerId(w.username)");
    expect(sources).toContain("finalRankId(item.username)");
    expect(sources).toContain("settingsStepId(item.id)");
    expect(sources).toContain("lobbyMuteId(item.username)");
    expect(sources).toContain("scoreMuteId(player.username)");
    expect(sources).toContain("reactionPillId(username)");
    expect(sources).toContain("reportReasonId(reason)");
    expect(sources).toContain("chatReportId(username)");
  });

  it("only uses registered ids in Maestro flows", () => {
    const known = [
      ...Object.values(TEST_IDS),
      playerOptionId(".*"),
      playerOptionId("bot1"),
      // EXP-250 many-players flow: a late bot and the device's own (last) option
      playerOptionId("bot10"),
      playerOptionId("${USERNAME}"),
      lobbyPlayerId(".*"),
      // EXP-157 lobby-host-drop flow: the bot host's row
      lobbyPlayerId("bot1"),
      lobbyPlayerOfflineId("bot1"),
      // EXP-172 play-again-linger flow: nobody may show as offline, and a deliberate wait on an absent id
      lobbyPlayerOfflineId("bot2"),
      lobbyPlayerOfflineId("${USERNAME}"),
      "never-shown-linger-wait",
      // EXP-206 invite-link-after-game flow: the linked room's own players, and nobody offline there
      lobbyPlayerId("bot3"),
      lobbyPlayerId("${USERNAME}"),
      lobbyPlayerOfflineId(".*"),
      roundsOptionId(0).replace("0", ".*"),
      // settings-instructions flow: the first step of the carousel
      settingsStepId(1),
      // EXP-085 / EXP-348 tie flows: the device user and the two tied bots
      ...["${USERNAME}", "bot1", "bot2"].flatMap((u) => [winnerNameId(u), finalWinnerId(u), finalRankId(u)]),
      // EXP-290 quit-after-game-over flow: the bot that quit at game over, in none of the next game's lists
      lobbyPlayerOfflineId("bot3"), playerOptionId("bot3"), scoreRankId("bot3"), finalRankId("bot3"),
      // EXP-425 device-host-kick-mid-game flow: the device host removes bot3 from a scoreboard; bot1's row stays
      scoreRemoveId("bot3"), scoreRankId("bot1"),
      // EXP-422 mute-player flow: the bots muted in the lobby and on the scoreboard, and their reactions
      lobbyMuteId("bot1"), scoreMuteId("bot1"), scoreMuteId("bot2"),
      ...["bot1", "bot2", "bot3"].map(reactionPillId),
      // EXP-423 report-photo flow: the second bot in the device's room, and the reason it picks
      lobbyPlayerId("bot2"), reportReasonId("sexual"),
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
