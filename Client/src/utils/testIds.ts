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
  homeLogo: "home-logo", // fades out while the keyboard is up
  joinPanel: "join-panel", // room code + Search room, lifted above the keyboard
  gameCodeInput: "game-code-input",
  searchRoomButton: "search-room-button",
  ownPhotosButton: "own-photos-button",
  homeLimitedBanner: "home-limited-banner", // only part of the gallery is shared
  homeLimitedAddMore: "home-limited-add-more",
  homePrivacyLink: "home-privacy-link",
  // ── Waiting room ──
  closeButton: "close-button",
  lobbyCodeBlock: "lobby-code-block", // the "Room code" title and the code with its copy and share buttons
  lobbyGameCode: "lobby-game-code",
  copyCodeButton: "copy-code-button",
  shareCodeButton: "share-code-button",
  plantPhotoButton: "plant-photo-button",
  plantPhotoPlanted: "plant-photo-planted", // plant button state: a photo is planted
  plantPhotoNotPlanted: "plant-photo-not-planted",
  startGameButton: "start-game-button",
  startGameNotice: "start-game-notice", // why the host's Start didn't start the game
  lobbyWaiting: "lobby-waiting",
  lobbyHostHint: "lobby-host-hint", // host only, while Start isn't offered: "send the code to your friends"
  lobbyLoading: "lobby-loading", // shown until the join answer says this is a lobby (a started game opens the game)
  // Replaces lobbyLoading when the socket doesn't connect in time (EXP-417)
  serverUnreachable: "server-unreachable",
  serverUnreachableRetry: "server-unreachable-retry",
  serverUnreachableBack: "server-unreachable-back",
  chatInput: "chat-input",
  chatSendButton: "chat-send-button",
  lobbyChatMessages: "lobby-chat-messages", // the chat bubbles' area, from under the room code down to the chat input
  // Invite link confirmation (DEC-046): nothing joins until Join
  inviteConfirmModal: "invite-confirm-modal",
  inviteRoomCode: "invite-room-code",
  inviteNameInput: "invite-name-input",
  inviteJoinButton: "invite-join-button",
  inviteCancelButton: "invite-cancel-button",
  // ── Game ──
  gameWaitingReady: "game-waiting-ready",
  gameLoading: "game-loading", // opened on a game in progress: shown until the server's snapshot says its phase
  gameWaitingPhoto: "game-waiting-photo",
  waitingPhotoText: "waiting-photo-text",
  roundSkippedNotice: "round-skipped-notice",
  holdButton: "hold-button",
  gameHeld: "game-held", // invisible marker while the photo owner holds the scoreboard (game layer hidden)
  photoView: "photo-view", // PhotoComponent: the game photo (also the own-photos viewer)
  photoLoading: "photo-loading", // PhotoComponent: shown until the photo has loaded
  roundProgress: "round-progress",
  answerOptions: "answer-options",
  reconnectingBanner: "reconnecting-banner",
  gameServerUnreachable: "game-server-unreachable", // the banner once the reconnection has taken too long (EXP-429)
  gameServerUnreachableRetry: "game-server-unreachable-retry",
  pausedModal: "paused-modal",
  pausedCountdown: "paused-countdown",
  pausedCounter: "paused-counter",
  pausedLastWarning: "paused-last-warning",
  pausedWaitingFor: "paused-waiting-for",
  // Leaving a game in progress (EXP-377): the game's Exit, the pause modal's, and the question both open
  leaveGameButton: "leave-game-button",
  pausedLeaveButton: "paused-leave-button",
  leaveGameConfirm: "leave-game-confirm", // its Cancel / Leave are alertModalCancel / alertModalConfirm
  // The host removing a player during the game (EXP-425): its Cancel / Remove are alertModalCancel / alertModalConfirm
  removePlayerConfirm: "remove-player-confirm",
  // Over a muted player's round photo (EXP-422), until its Show reveals it for this round
  mutedPhotoCover: "muted-photo-cover",
  mutedPhotoShowButton: "muted-photo-show-button",
  scoreShowMutedPhoto: "score-show-muted-photo", // the same Show on the scoreboard, which covers the cover's
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
  settingsInstructionsBack: "settings-instructions-back",
  settingsPrivacyLink: "settings-privacy-link",
  settingsContactLink: "settings-contact-link", // only when the build has a contact address (EXPO_PUBLIC_CONTACT_EMAIL)
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
  finalTitle: "final-title", // "Final Results", or "No result" when nobody scored (DEC-044)
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
/** The host's remove button on a player's scoreboard row, and on an awaited player in the pause modal (EXP-425) */
export const scoreRemoveId = (username: string) => `score-remove-${username}`;
export const pausedRemoveId = (username: string) => `paused-remove-${username}`;
/** Mute / unmute another player on this device (EXP-422): lobby rows, scoreboard rows, awaited players when paused */
export const lobbyMuteId = (username: string) => `lobby-mute-${username}`;
export const scoreMuteId = (username: string) => `score-mute-${username}`;
export const pausedMuteId = (username: string) => `paused-mute-${username}`;
/** An emoji reaction's pill over the photo, by its sender (EXP-422: a muted player's never shows) */
export const reactionPillId = (username: string) => `reaction-${username}`;
export const roundsOptionId = (rounds: number) => `rounds-option-${rounds}`;
/** Description text of a SettingsInstructionsScreen carousel step, numbered from 1 */
export const settingsStepId = (step: number) => `settings-step-${step}`;
