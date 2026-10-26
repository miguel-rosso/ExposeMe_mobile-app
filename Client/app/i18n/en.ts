export default {
  // Index
  appName: "Expose Me",
  enterUsername: "Enter username",
  createGame: "Create Game",
  joinGame: "Join Game",
  enterGameCode: "Enter game code",
  searchRoom: "Search Room",
  photoExplorer: "Photo Explorer",

  // WaitingRoom
  gameCode: "Game Code",
  rounds: "Rounds",
  plantPhoto: "Plant Photo",
  photoPlanted: "Photo Planted",
  startGame: "Start Game",
  waitingForPlayers: "Waiting for players",
  waitingHost: "Waiting host",
  sendCodeToFriends: "Send the game code to your friends so they can join!",
  typeMessage: "Type a message...",
  confirmRemovePlayer: "Confirm Remove Player",
  areYouSureRemove: "Are you sure you want to remove",
  remove: "Remove",
  cancel: "Cancel",
  loadingGameRoom: "Loading game room...",
  pleaseWait: "Please wait a moment",
  gameCodeCopied: "Game code copied",
  photoSelectedForGame: "Photo selected for the game!",
  selectingPhoto: "Selecting your photo...",
  slowDown: "Slow down",
  pleaseWaitBeforeSending: "Please wait before sending another message",
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

  // Server errors (see app/utils/serverMessage.ts)
  serverErrorTooManyAttempts: "Too many attempts. Wait a moment and try again.",
  serverErrorTooManyConnections: "Too many connections from this network. Try again in a moment.",
  serverErrorInvalidUsername: "That name isn't valid. Try a different one.",
  serverErrorGameNotFound: "Game not found. Check the code and try again.",
  serverErrorGameAlreadyStarted: "This game has already started.",
  serverErrorUsernameTaken: "That name is already taken in this game. Choose another one.",
  serverErrorRoomFull: "This game is full.",
  serverErrorServerBusy: "The server is busy. Try again in a moment.",
  serverErrorUnknown: "Something went wrong. Try again.",
  kickedByHost: "The host removed you from the room.",
  serverNoticeTitle: "Notice",
  ok: "OK",

  // GameScreen
  areYouReady: "ARE YOU READY?",
  holdPhoto: "Hold photo",
  reconnecting: "Reconnecting…",
  gamePaused: "Game paused",
  waitingPlayersReturn: "Waiting for players to come back…",
  pauseOf: "Pause {pause} of {max}",
  lastPauseWarning: "Last pause: if nobody comes back, the game will end.",
  someoneChoosingPhoto: "Someone is choosing a photo…",
  roundSkippedTimeout: "The photo didn't arrive in time. Round skipped.",
  roundSkippedUnavailable: "The chosen player had no photo to show. Round skipped.",
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
  warning: "⚠️ Warning ⚠️",
  permissionExplanation: "ExposeMe needs access to your photos: on your turns a random photo from your gallery (or from the ones you selected) is uploaded and shown to the other players in your room, and deleted when the game ends.",
  requiredPermission: "Required Permission Setting:",
  allowAll: '"Allow all" (or select some photos)',
  howToEnableAndroid: "How to enable on Android:",
  howToEnableIOS: "How to enable on iOS:",
  step1: "Step 1",
  step2: "Step 2",
  step3: "Step 3",
  tapAllowAll: "Allow access to all your photos or only to the ones you select.",
  continue_: "Continue",
  tapToProceed: "Tap to proceed after setting permissions",

  // SettingsInstructionsScreen
  careful: "⚠️ Careful ⚠️",
  fullAccessExplanation: "To play, ExposeMe needs access to your photos: to all of them or to a selection with at least one photo.",
  alwaysAllowAll: "Allow access to your photos",
  androidInstructions: "Android Instructions:",
  iosInstructions: "iOS Instructions:",
  androidTapPermissions: 'Tap "Permissions".',
  tapPhotosVideos: "Tap on access to Photos and videos.",
  allowAllTime: 'Choose "Allow all" or "Select photos".',
  iosTapPhotosChooseAccess: 'Tap "Photos" and choose "Full Access" or "Limited Access".',
  iosConfirmFullAccess: 'If you choose "Full Access", confirm with "Allow Full Access".',
  back: "Back",
  openSettings: "Open Settings",

  // OwnPhotos
  next: "Next",

  // General
  confirm: "Confirm",

  // LanguageToggle
  changeLanguage: "Change language",

  // WinnerModal singular
  pointsOne: "{points} point",

  // WaitingRoom: player gone (disconnected past the server's grace)
  playerDisconnected: "disconnected",

  // WaitingRoom / GameScreen: tag next to your own name in player lists
  you: "You",

  // GameScreen: shown next to a player's name when they take a screenshot
  tookScreenshot: "took a screenshot",
} as const;
