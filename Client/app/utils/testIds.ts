// Stable selectors for E2E flows (qa/maestro) and unit tests.
// Never derive these from translated text: flows must work in every language.
export const TEST_IDS = {
  // ── First run ──
  initialScreen: "initial-screen",
  initialContinueButton: "initial-continue-button",
  initialTitle: "initial-title",
  // ── Home ──
  usernameInput: "username-input",
  usernameClearButton: "username-clear-button",
  createGameButton: "create-game-button",
  joinGameButton: "join-game-button",
  gameCodeInput: "game-code-input",
  searchRoomButton: "search-room-button",
  ownPhotosButton: "own-photos-button",
  homeLimitedBanner: "home-limited-banner", // only part of the gallery is shared
  homeLimitedAddMore: "home-limited-add-more",
  // ── Waiting room ──
  closeButton: "close-button",
  lobbyGameCode: "lobby-game-code",
  copyCodeButton: "copy-code-button",
  shareCodeButton: "share-code-button",
  plantPhotoButton: "plant-photo-button",
  plantPhotoPlanted: "plant-photo-planted", // plant button state: a photo is planted
  plantPhotoNotPlanted: "plant-photo-not-planted",
  startGameButton: "start-game-button",
  lobbyWaiting: "lobby-waiting",
  lobbyLoading: "lobby-loading", // shown until the join answer says this is a lobby (a started game opens the game)
  chatInput: "chat-input",
  chatSendButton: "chat-send-button",
  // ── Game ──
  gameWaitingReady: "game-waiting-ready",
  gameLoading: "game-loading", // opened on a game in progress: shown until the server's snapshot says its phase
  gameWaitingPhoto: "game-waiting-photo",
  waitingPhotoText: "waiting-photo-text",
  roundSkippedNotice: "round-skipped-notice",
  holdButton: "hold-button",
  photoView: "photo-view", // PhotoComponent: the game photo (also the own-photos viewer)
  photoLoading: "photo-loading", // PhotoComponent: shown until the photo has loaded
  roundProgress: "round-progress",
  answerOptions: "answer-options",
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
  // ── Settings instructions ──
  settingsInstructionsScreen: "settings-instructions-screen",
  settingsInstructionsOpenSettings: "settings-instructions-open-settings",
  // ── Modals ──
  alertModal: "alert-modal",
  alertModalConfirm: "alert-modal-confirm",
  alertModalCancel: "alert-modal-cancel",
  scoreModal: "score-modal",
  scoreList: "score-list",
  scoreRoundTitle: "score-round-title",
  scoreAnswerCard: "score-answer-card", // whose photo it was
  scoreAnswerName: "score-answer-name", // its large text: the name, or "It was your photo!" for the owner
  winnerModal: "winner-modal",
  winnerContinue: "winner-continue",
  winnerTitle: "winner-title",
  finalScoreModal: "final-score-modal",
  finalExitButton: "final-exit-button",
  playAgainButton: "play-again-button",
  // ── Language ──
  languageToggle: "language-toggle",
} as const;

export const playerOptionId = (username: string) => `player-option-${username}`;
/** Emoji bar button, by its position in REACTION_EMOJIS (ASCII ids: Maestro selectors can't hold the emoji itself) */
export const emojiButtonId = (index: number) => `emoji-button-${index}`;
export const lobbyPlayerId = (username: string) => `lobby-player-${username}`;
/** "disconnected" label on a gone player's lobby row (EXP-157) */
export const lobbyPlayerOfflineId = (username: string) => `lobby-player-offline-${username}`;
export const winnerNameId = (username: string) => `winner-name-${username}`;
export const finalWinnerId = (username: string) => `final-winner-${username}`;
export const finalRankId = (username: string) => `final-rank-${username}`;
export const scoreRankId = (username: string) => `score-rank-${username}`;
export const scoreGuessId = (username: string) => `score-guess-${username}`;
export const roundsOptionId = (rounds: number) => `rounds-option-${rounds}`;
/** Description text of a SettingsInstructionsScreen carousel step, numbered from 1 */
export const settingsStepId = (step: number) => `settings-step-${step}`;
