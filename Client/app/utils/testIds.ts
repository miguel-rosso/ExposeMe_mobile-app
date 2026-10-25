// Stable selectors for E2E flows (qa/maestro) and unit tests.
// Never derive these from translated text: flows must work in every language.
export const TEST_IDS = {
  // ── First run ──
  initialScreen: "initial-screen",
  initialContinueButton: "initial-continue-button",
  // ── Home ──
  usernameInput: "username-input",
  usernameClearButton: "username-clear-button",
  createGameButton: "create-game-button",
  joinGameButton: "join-game-button",
  gameCodeInput: "game-code-input",
  searchRoomButton: "search-room-button",
  ownPhotosButton: "own-photos-button",
  // ── Waiting room ──
  closeButton: "close-button",
  lobbyGameCode: "lobby-game-code",
  copyCodeButton: "copy-code-button",
  shareCodeButton: "share-code-button",
  plantPhotoButton: "plant-photo-button",
  startGameButton: "start-game-button",
  lobbyWaiting: "lobby-waiting",
  chatInput: "chat-input",
  chatSendButton: "chat-send-button",
  // ── Game ──
  gameWaitingReady: "game-waiting-ready",
  holdButton: "hold-button",
  reconnectingBanner: "reconnecting-banner",
  pausedModal: "paused-modal",
  pausedCountdown: "paused-countdown",
  // ── Modals ──
  alertModal: "alert-modal",
  alertModalConfirm: "alert-modal-confirm",
  alertModalCancel: "alert-modal-cancel",
  scoreModal: "score-modal",
  winnerModal: "winner-modal",
  winnerContinue: "winner-continue",
  finalScoreModal: "final-score-modal",
  finalExitButton: "final-exit-button",
  playAgainButton: "play-again-button",
} as const;

export const playerOptionId = (username: string) => `player-option-${username}`;
export const lobbyPlayerId = (username: string) => `lobby-player-${username}`;
export const roundsOptionId = (rounds: number) => `rounds-option-${rounds}`;
