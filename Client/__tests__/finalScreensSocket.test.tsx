import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { TEST_IDS } from "../app/utils/testIds";
import { ScoreRound } from "../app/models/interfaces";
import WinnerModal from "../app/components/modals/WinnerModal";
import FinalScoreModal from "../app/components/modals/FinalScoreModal";

// EXP-172: the winner and final screens keep the socket (the player is still in the room). "Play again" goes to the
// lobby on the same socket and drops the planted photo of the game that ended (EXP-035); Exit leaves the room (the
// shared leave of GameContext, EXP-254).

const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
const mockEndSocket = jest.fn();
const mockSetPlanted = jest.fn();
const mockClearToken = jest.fn();
const mockLeaveRoom = jest.fn();
const mockMarkRoomExit = jest.fn();
const mockSocket = { emit: jest.fn(), disconnect: jest.fn() };
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("lottie-react-native", () => "LottieView");
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: mockReplace, dismissTo: mockDismissTo }) }));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    socket: mockSocket, endSocket: mockEndSocket, setRoundsOfGame: jest.fn(), setPlayersProvider: jest.fn(),
    clearRejoinToken: mockClearToken, setPlantedPhotoUri: mockSetPlanted, leaveRoom: mockLeaveRoom,
    markRoomExit: mockMarkRoomExit, setHomeNotice: jest.fn(),
  }),
}));

const s = (username: string, points: number): ScoreRound => ({ username, points, isHost: false, lastAnswerCorrect: false, lastGuess: "" });
const scores = [s("bob", 3), s("ana", 1)];
const render = (el: React.ReactElement) => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(el); });
  return r;
};
const press = (root: ReactTestInstance, id: string) =>
  act(() => root.find((n) => n.props.testID === id && typeof n.props.onPress === "function").props.onPress());

beforeEach(() => {
  [mockReplace, mockDismissTo, mockEndSocket, mockSetPlanted, mockClearToken, mockLeaveRoom, mockMarkRoomExit, mockSocket.emit, mockSocket.disconnect].forEach((m) => m.mockClear());
});

describe("final screens keep the socket (EXP-172)", () => {
  it("the winner screen does not end the socket", () => {
    const r = render(<WinnerModal visible winners={[s("bob", 3)]} onAnimationEnd={jest.fn()} />);
    expect(mockEndSocket).not.toHaveBeenCalled();
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("the final ranking does not end the socket", () => {
    const r = render(<FinalScoreModal visible finalScore={scores} />);
    expect(mockEndSocket).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("Play again: same socket to the lobby, planted photo dropped, no leave", () => {
    const r = render(<FinalScoreModal visible finalScore={scores} />);
    press(r.root, TEST_IDS.playAgainButton);
    expect(mockSetPlanted).toHaveBeenCalledWith(null);
    expect(mockReplace).toHaveBeenCalledWith("/screens/WaitingRoom");
    expect(mockEndSocket).not.toHaveBeenCalled();
    expect(mockClearToken).not.toHaveBeenCalled();
    expect(mockLeaveRoom).not.toHaveBeenCalled();
    expect(mockMarkRoomExit).not.toHaveBeenCalled();
    expect(mockSocket.emit).not.toHaveBeenCalledWith("leave-room");
    act(() => r.unmount());
  });

  it("Exit: leaves the room (leave-room, rejoin token forgotten, socket closed once acked) and goes home", () => {
    const r = render(<FinalScoreModal visible finalScore={scores} />);
    press(r.root, TEST_IDS.finalExitButton);
    expect(mockLeaveRoom).toHaveBeenCalledTimes(1);
    // Not closed here: closing in the same tick as the leave-room could lose it (EXP-254)
    expect(mockEndSocket).not.toHaveBeenCalled();
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
    expect(mockDismissTo).toHaveBeenCalledWith("/");
    // The room's own way out (EXP-373): home may close what is left of the room's connection
    expect(mockMarkRoomExit).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });
});
