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
  gameWaitingPhoto: "game-waiting-photo",
  waitingPhotoText: "waiting-photo-text",
  roundSkippedNotice: "round-skipped-notice",
  holdButton: "hold-button",
  reconnectingBanner: "reconnecting-banner",
  pausedModal: "paused-modal",
  pausedCountdown: "paused-countdown",
  pausedCounter: "paused-counter",
  pausedLastWarning: "paused-last-warning",
  // ── Gallery access (home, lobby, game) ──
  galleryAccessModal: "gallery-access-modal",
  galleryAccessMessage: "gallery-access-message",
  galleryAllowButton: "gallery-allow-button",
  gallerySelectPhotosButton: "gallery-select-photos-button",
  gallerySettingsButton: "gallery-settings-button",
  galleryRetryButton: "gallery-retry-button",
  galleryHelpButton: "gallery-help-button",
  galleryBackButton: "gallery-back-button",
  // ── Modals ──
  alertModal: "alert-modal",
  alertModalConfirm: "alert-modal-confirm",
  alertModalCancel: "alert-modal-cancel",
  scoreModal: "score-modal",
  winnerModal: "winner-modal",
  winnerContinue: "winner-continue",
  winnerTitle: "winner-title",
  finalScoreModal: "final-score-modal",
  finalExitButton: "final-exit-button",
  playAgainButton: "play-again-button",
} as const;

export const playerOptionId = (username: string) => `player-option-${username}`;
export const lobbyPlayerId = (username: string) => `lobby-player-${username}`;
export const winnerNameId = (username: string) => `winner-name-${username}`;
export const finalWinnerId = (username: string) => `final-winner-${username}`;
export const finalRankId = (username: string) => `final-rank-${username}`;
export const scoreRankId = (username: string) => `score-rank-${username}`;
export const roundsOptionId = (rounds: number) => `rounds-option-${rounds}`;
