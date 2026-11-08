export default {
  // Index
  appName: "Expose Me",
  enterUsername: "Enter username",
  createGame: "Create Game",
  joinGame: "Join Game",
  enterGameCode: "Enter game code",
  searchRoom: "Search Room",
  photoExplorer: "Photo Explorer",
  // Home banner while only part of the gallery is shared (iOS limited, Android 14+ selected photos)
  limitedAccessBanner: "Only some photos shared",
  addMorePhotos: "Add more",
  // Screen reader names of the home's icon-only buttons
  clearUsername: "Clear username",
  clearGameCode: "Clear game code",

  // WaitingRoom
  gameCode: "Game Code",
  rounds: "Rounds",
  plantPhoto: "Plant Photo",
  photoPlanted: "Photo Planted",
  plantingPhoto: "Uploading…",
  plantPhotoFailed: "Your photo couldn't be uploaded. Try again.",
  startGame: "Start Game",
  startingGame: "Starting…",
  // WaitingRoom: why the host's Start didn't start the game
  startRefusedPlayerGone: "{name} was disconnected and has left the room.",
  startRefusedPlayersGone: "The disconnected players have left the room.",
  startRefusedNotEnoughPlayers: "At least 2 players are needed to start.",
  startGameFailed: "Couldn't start the game. Try again.",
  waitingForPlayers: "Waiting for players",
  waitingHost: "Waiting for the host",
  sendCodeToFriends: "Send the game code to your friends so they can join!",
  typeMessage: "Type a message...",
  // Screen reader names of the lobby's icon-only buttons
  copyGameCode: "Copy game code",
  shareGameCode: "Share game code",
  sendMessage: "Send message",
  leaveRoom: "Leave room",
  confirmRemovePlayer: "Remove player",
  // {name}: the player, highlighted by the dialog
  areYouSureRemove: "Are you sure you want to remove {name} from the room?",
  remove: "Remove",
  // The host's remove buttons during the game (scoreboard rows, pause modal; EXP-425), named for screen readers
  removePlayerNamed: "Remove {name}",
  // Muting a player on this device (EXP-422): lobby and game player rows, named for screen readers
  mutePlayerNamed: "Mute {name}",
  unmutePlayerNamed: "Unmute {name}",
  // GameScreen: over the round's photo when it is a muted player's, until "Show" reveals it for this round
  mutedPlayerPhoto: "Photo from a muted player",
  showMutedPhoto: "Show",
  // Reporting the round photo or another player's chat message (EXP-423): the buttons, named for screen readers
  reportPhoto: "Report photo",
  reportMessageFrom: "Report message from {name}",
  // The reason picker, then the answer
  reportTitle: "Why are you reporting this?",
  reportReasonSexual: "Sexual content",
  reportReasonViolence: "Violence or hate",
  reportReasonHarassment: "Harassment",
  reportReasonOther: "Other",
  reportSending: "Sending…",
  reportThanks: "Thanks, we'll review it",
  reportRefused: "This can't be reported.",
  reportFailed: "The report couldn't be sent.",
  reportMutedPlayerNamed: "You muted {name}",
  cancel: "Cancel",
  loadingGameRoom: "Loading game room...",
  pleaseWait: "Please wait a moment",
  // Shown instead of the loading spinner when the server doesn't answer (EXP-417): its buttons are tryAgain and back
  serverUnreachable: "Can't connect to the server. Check your connection.",
  gameCodeCopied: "Game code copied",
  photoSelectedForGame: "Photo selected for the game!",
  selectingPhoto: "Selecting your photo...",
  slowDown: "Slow down",
  pleaseWaitBeforeSending: "Please wait before sending another message",
  chatMessageNotSent: "Your message couldn't be sent. Check your connection.",
  plantSecretPhoto: "Plant a Secret Photo",
  choosePhotoDescription: "Choose a photo that will appear at a random moment in the game.",
  choosePhoto: "Choose Photo",
  photoAlreadyPlanted: "Photo Already Planted",
  changePhotoQuestion: "Would you like to change your planted photo?",
  keepCurrentPhoto: "Keep Current Photo",
  changePhoto: "Change Photo",
  permissionRequired: "Permission Required",
  needPhotoAccess: "We need access to your photos to plant an image in the game.",
  error: "Error",
  errorSelectingImage: "There was an error selecting your image.",
  shareMessage: "Join my ExposeMe game!\n",

  // Server errors (see src/utils/serverMessage.ts)
  serverErrorTooManyAttempts: "Too many attempts. Wait a moment and try again.",
  serverErrorTooManyConnections: "Too many connections from this network. Try again in a moment.",
  serverErrorInvalidUsername: "That name isn't valid. Try a different one.",
  serverErrorGameNotFound: "Game not found. Check the code and try again.",
  serverErrorGameAlreadyStarted: "This game has already started.",
  serverErrorUsernameTaken: "That name is already taken in this game. Choose another one.",
  serverErrorUsernameTooSimilar: "That name looks too much like another player's. Choose another one.",
  serverErrorRoomFull: "This game is full.",
  serverErrorServerBusy: "The server is busy. Try again in a moment.",
  serverErrorUnknown: "Something went wrong. Try again.",
  kickedByHost: "The host removed you from the room.",
  unknownLinkNotice: "That link doesn't work: it may be mistyped or out of date.",
  serverNoticeTitle: "Notice",
  ok: "OK",

  // GameScreen
  loadingGame: "Loading game…",
  holdPhoto: "Hold photo",
  noHoldsLeft: "No holds left",
  reconnecting: "Reconnecting…",
  // The reconnecting banner once the connection has taken too long (EXP-429): a title, a hint, and tryAgain
  gameServerUnreachable: "No connection to the server.",
  gameServerUnreachableHint: "You'll be back in the game once it reconnects.",
  gamePaused: "Game paused",
  waitingPlayersReturn: "Waiting for players to come back…",
  pauseOf: "Pause {pause} of {max}",
  lastPauseWarning: "Last pause: if nobody comes back, the game will end.",
  // Who the pause waits for (EXP-380): "{names}" is listed by src/utils/waitingFor
  waitingForNames: "Waiting for {names}…",
  namesListAnd: "and",
  namesListAndBeforeI: "and",
  namesListMore: "{count} more",
  // Ready phase: nothing to press, the server starts the first round once every device is ready (EXP-382)
  waitingEveryoneReady: "Waiting for everyone to be ready…",
  // Leaving a game in progress (EXP-377)
  leaveGame: "Leave game",
  leaveGameConfirmTitle: "Leave the game?",
  leaveGameConfirmMessage: "You won't be able to rejoin.",
  leaveGameConfirm: "Leave",
  someoneChoosingPhoto: "Someone is choosing a photo…",
  roundSkipped: "No photo this time. Round skipped.",
  ownPhotoTimeout: "Your photo didn't arrive in time, so your round was skipped.",
  ownPhotoNoPermission: "We can't access your photos, so your round was skipped. Allow photo access in Settings to play your turn.",
  ownPhotoNoPhotos: "There are no photos we can use in your gallery, so your round was skipped.",
  ownPhotoFailed: "We couldn't open a photo from your gallery, so your round was skipped.",
  ownPhotoUploadFailed: "Your photo couldn't be uploaded, so your round was skipped. Check your connection.",

  // GalleryAccessModal
  galleryAccessTitle: "Photo access needed",
  galleryAccessDenied: "ExposeMe plays with the photos in your gallery, so you can't play without access to them. On your turns a random photo from your gallery (or from the ones you selected) is uploaded and shown to the other players in your room, and deleted when the game ends. Allow access to all your photos or to a selection.",
  galleryNoPhotosTitle: "No photos",
  galleryNoPhotos: "You need at least one photo in your gallery to play.",
  galleryNoPhotosLimited: "You need at least one photo in your gallery to play. You only shared some photos and none can be used: select more photos or allow access to all of them.",
  galleryUnavailableTitle: "Gallery unavailable",
  galleryUnavailable: "We couldn't read your gallery, try again.",
  galleryBlockedNote: "This disappears as soon as you allow access again.",
  allowAccess: "Allow access",
  selectPhotos: "Select photos",
  tryAgain: "Try again",
  howToEnable: "How do I enable it?",

  // ScoreModal
  roundOf: "Round {round} of {total}",
  // Whose photo it was (the owner only learns it here: they play like everyone, EXP-252)
  photoWasFrom: "This photo was from",
  itWasYourPhoto: "It was your photo!",
  noGuess: "No guess",

  // FinalScoreModal
  gameOver: "GAME OVER",
  finalResults: "Final Results",
  // Nobody scored (DEC-044): no winner and no celebration
  noResult: "No result",
  noResultHint: "Nobody scored any points",
  exit: "Exit",
  playAgain: "Play Again",
  pts: "pts",

  // WinnerModal
  winner: "WINNER!",
  winners: "WINNERS!",
  tie: "It's a tie!",
  points: "{points} points",
  tapToContinue: "Tap anywhere to continue",

  // InitialScreen
  initialTitle: "YOUR GALLERY\nIS THE GAME",
  initialSubtitle: "On your turn a random photo from your gallery appears. Everyone else guesses whose it is.",
  initialPointRandom: "One random photo, only on your turns",
  initialPointRoom: "Only your room sees it",
  initialPointDeleted: "Deleted when the game ends",
  initialFootnote: "You can share all your photos or just some.",
  step1: "Step 1",
  step2: "Step 2",
  step3: "Step 3",

  // SettingsInstructionsScreen
  careful: "⚠️ Careful ⚠️",
  fullAccessExplanation: "To play, ExposeMe needs access to your photos: to all of them or to a selection with at least one photo.",
  alwaysAllowAll: "Allow access to your photos",
  androidInstructions: "Android Instructions:",
  iosInstructions: "iOS Instructions:",
  androidTapPermissions: 'Tap "Permissions".',
  tapPhotosVideos: "Tap on access to Photos and videos.",
  allowAllTime: 'Choose "Allow all" or "Select photos".',
  iosTapPhotosChooseAccess:
    'If Settings opens on its main page, go to "Apps" > "Expose Me". Tap "Photos" and choose "Full Access" or "Limited Access".',
  iosConfirmFullAccess: 'If you choose "Full Access", confirm with "Allow Full Access".',
  back: "Back",
  openSettings: "Open Settings",
  // Settings and home: the privacy policy page and the contact address (EXP-426)
  privacyPolicy: "Privacy policy",
  privacy: "Privacy", // home: the short text of the same link (its screen reader name is privacyPolicy)
  contactUs: "Contact",

  // OwnPhotos
  next: "Next",

  // General
  confirm: "Confirm",
  close: "Close",

  // Shown in place of a screen that crashed while rendering (EXP-435): its buttons are tryAgain and errorScreenHome
  errorScreenTitle: "Something went wrong",
  errorScreenMessage: "An unexpected error occurred.",
  errorScreenHome: "Back to home",

  // LanguageToggle
  changeLanguage: "Change language",

  // WinnerModal singular
  pointsOne: "{points} point",

  // WaitingRoom: confirmation shown when an invite link opens it
  inviteJoinTitle: "Join this room?",
  inviteNameLabel: "Your name",
  inviteJoin: "Join",
  // GameScreen: the invite dialog closed because the host started the next game (DEC-049)
  inviteClosedTitle: "Invite closed",
  inviteClosedByNextGame: "The invite to {room} was closed because another game started.",

  // WaitingRoom: player gone (disconnected past the server's grace)
  playerDisconnected: "disconnected",

  // WaitingRoom / GameScreen: tag next to your own name in player lists
  you: "You",

  // GameScreen: shown next to a player's name when they take a screenshot
  tookScreenshot: "took a screenshot",

  // InitialScreen: the terms of use the player accepts before sharing anything (EXP-433, DEC-058). {terms} and
  // {privacy} are the two links, labelled termsOfUse and privacyPolicy
  termsAcceptAndContinue: "Accept and continue",
  termsConsent: "By continuing you accept the {terms} and the {privacy}",
  termsOfUse: "Terms",
} as const;
