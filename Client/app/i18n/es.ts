export default {
  // Index
  appName: "Expose Me",
  enterUsername: "Introduce tu nombre",
  createGame: "Crear Partida",
  joinGame: "Unirse a Partida",
  enterGameCode: "Código de sala",
  searchRoom: "Buscar Sala",
  photoExplorer: "Explorar Fotos",
  // Home banner while only part of the gallery is shared (iOS limited, Android 14+ selected photos)
  limitedAccessBanner: "Solo algunas fotos",
  addMorePhotos: "Añadir más",
  // Screen reader names of the home's icon-only buttons
  clearUsername: "Borrar nombre",
  clearGameCode: "Borrar código de sala",

  // WaitingRoom
  gameCode: "Código de Sala",
  rounds: "Rondas",
  plantPhoto: "Plantar Foto",
  photoPlanted: "Foto Plantada",
  plantingPhoto: "Subiendo…",
  plantPhotoFailed: "No se pudo subir tu foto. Inténtalo de nuevo.",
  startGame: "Iniciar Partida",
  waitingForPlayers: "Esperando jugadores",
  waitingHost: "Esperando al host",
  sendCodeToFriends: "¡Envía el código a tus amigos para que se unan!",
  typeMessage: "Escribe un mensaje...",
  // Screen reader names of the lobby's icon-only buttons
  copyGameCode: "Copiar código de sala",
  shareGameCode: "Compartir código de sala",
  sendMessage: "Enviar mensaje",
  leaveRoom: "Salir de la sala",
  confirmRemovePlayer: "Confirmar Expulsión",
  areYouSureRemove: "¿Estás seguro de que quieres expulsar a",
  remove: "Expulsar",
  cancel: "Cancelar",
  loadingGameRoom: "Cargando sala...",
  pleaseWait: "Espera un momento",
  gameCodeCopied: "Código copiado",
  photoSelectedForGame: "¡Foto seleccionada para la partida!",
  selectingPhoto: "Seleccionando foto...",
  slowDown: "Ve más despacio",
  pleaseWaitBeforeSending: "Espera antes de enviar otro mensaje",
  plantSecretPhoto: "Plantar Foto Secreta",
  choosePhotoDescription: "Elige una foto que aparecerá en un momento aleatorio de la partida.",
  choosePhoto: "Elegir Foto",
  photoAlreadyPlanted: "Foto Ya Plantada",
  changePhotoQuestion: "¿Quieres cambiar tu foto plantada?",
  keepCurrentPhoto: "Mantener Foto",
  changePhoto: "Cambiar Foto",
  permissionRequired: "Permiso Requerido",
  needPhotoAccess: "Necesitamos acceso a tus fotos para plantar una imagen.",
  error: "Error",
  errorSelectingImage: "Ha ocurrido un error al seleccionar la imagen.",
  shareMessage: "¡Únete a mi partida de ExposeMe!\n",

  // Server errors (see app/utils/serverMessage.ts)
  serverErrorTooManyAttempts: "Demasiados intentos. Espera un momento y vuelve a intentarlo.",
  serverErrorTooManyConnections: "Demasiadas conexiones desde esta red. Inténtalo de nuevo en un momento.",
  serverErrorInvalidUsername: "Ese nombre no es válido. Prueba con otro.",
  serverErrorGameNotFound: "No se ha encontrado la partida. Revisa el código e inténtalo de nuevo.",
  serverErrorGameAlreadyStarted: "Esta partida ya ha empezado.",
  serverErrorUsernameTaken: "Ese nombre ya está en uso en esta partida. Elige otro.",
  serverErrorUsernameTooSimilar: "Ese nombre se parece demasiado al de otro jugador. Elige otro.",
  serverErrorRoomFull: "Esta partida está llena.",
  serverErrorServerBusy: "El servidor está ocupado. Inténtalo de nuevo en un momento.",
  serverErrorUnknown: "Algo ha ido mal. Inténtalo de nuevo.",
  kickedByHost: "El anfitrión te ha sacado de la sala.",
  serverNoticeTitle: "Aviso",
  ok: "Aceptar",

  // GameScreen
  loadingGame: "Cargando partida…",
  areYouReady: "¿ESTÁS LISTO?",
  holdPhoto: "Mantener Foto",
  reconnecting: "Reconectando…",
  gamePaused: "Partida en pausa",
  waitingPlayersReturn: "Esperando a que vuelvan los jugadores…",
  pauseOf: "Pausa {pause} de {max}",
  lastPauseWarning: "Es la última pausa: si no vuelven, la partida terminará.",
  someoneChoosingPhoto: "Alguien está eligiendo una foto…",
  roundSkipped: "Esta vez no hubo foto. Ronda saltada.",
  ownPhotoTimeout: "Tu foto no llegó a tiempo, así que se ha saltado tu ronda.",
  ownPhotoNoPermission: "No podemos acceder a tus fotos, así que se ha saltado tu ronda. Permite el acceso a las fotos en Ajustes para jugar tu turno.",
  ownPhotoNoPhotos: "No hay fotos que podamos usar en tu galería, así que se ha saltado tu ronda.",
  ownPhotoFailed: "No hemos podido abrir una foto de tu galería, así que se ha saltado tu ronda.",
  ownPhotoUploadFailed: "No se ha podido subir tu foto, así que se ha saltado tu ronda. Revisa tu conexión.",

  // GalleryAccessModal
  galleryAccessTitle: "Necesitamos acceso a tus fotos",
  galleryAccessDenied: "ExposeMe se juega con las fotos de tu galería, así que no puedes jugar sin acceso a ellas. En tus turnos se sube una foto aleatoria de tu galería (o de las que hayas seleccionado), se muestra a los demás jugadores de tu sala y se borra al terminar la partida. Permite el acceso a todas tus fotos o a una selección.",
  galleryNoPhotosTitle: "No hay fotos",
  galleryNoPhotos: "Necesitas al menos una foto en tu galería para jugar.",
  galleryNoPhotosLimited: "Necesitas al menos una foto en tu galería para jugar. Solo has compartido algunas fotos y ninguna se puede usar: selecciona más fotos o permite el acceso a todas.",
  galleryUnavailableTitle: "Galería no disponible",
  galleryUnavailable: "No hemos podido leer tu galería, inténtalo de nuevo.",
  galleryBlockedNote: "Esto desaparecerá en cuanto vuelvas a permitir el acceso.",
  allowAccess: "Permitir acceso",
  selectPhotos: "Seleccionar fotos",
  tryAgain: "Reintentar",
  howToEnable: "¿Cómo lo activo?",

  // ScoreModal
  roundOf: "Ronda {round} de {total}",
  // Whose photo it was (the owner only learns it here: they play like everyone, EXP-252)
  photoWasFrom: "Esta foto era de",
  itWasYourPhoto: "¡Era tu foto!",
  noGuess: "Sin respuesta",

  // FinalScoreModal
  gameOver: "FIN DEL JUEGO",
  finalResults: "Resultados Finales",
  // Nobody scored (DEC-044): no winner and no celebration
  noResult: "Partida sin resultado",
  noResultHint: "Nadie ha sumado puntos",
  exit: "Salir",
  playAgain: "Jugar de Nuevo",
  pts: "pts",

  // WinnerModal
  winner: "¡GANADOR!",
  winners: "¡GANADORES!",
  tie: "¡Empate!",
  points: "{points} puntos",
  tapToContinue: "Toca para continuar",

  // InitialScreen
  initialTitle: "TU GALERÍA\nES EL JUEGO",
  initialSubtitle: "En tu turno sale una foto al azar de tu galería. Los demás adivinan de quién es.",
  initialPointRandom: "Una foto al azar, solo en tus turnos",
  initialPointRoom: "Solo la ve tu sala",
  initialPointDeleted: "Se borra al acabar la partida",
  initialFootnote: "Puedes compartir todas tus fotos o solo algunas.",
  step1: "Paso 1",
  step2: "Paso 2",
  step3: "Paso 3",
  continue_: "Continuar",

  // SettingsInstructionsScreen
  careful: "⚠️ Cuidado ⚠️",
  fullAccessExplanation: "Para jugar, ExposeMe necesita acceso a tus fotos: a todas o a una selección con al menos una foto.",
  alwaysAllowAll: "Permite el acceso a tus fotos",
  androidInstructions: "Instrucciones Android:",
  iosInstructions: "Instrucciones iOS:",
  androidTapPermissions: 'Pulsa en "Permisos".',
  tapPhotosVideos: "Pulsa en acceso a Fotos y vídeos.",
  allowAllTime: 'Elige "Permitir todo" o "Seleccionar fotos".',
  iosTapPhotosChooseAccess:
    'Si se abre la portada de Ajustes, ve a "Apps" > "Expose Me". Pulsa en "Fotos" y elige "Acceso total" o "Acceso limitado".',
  iosConfirmFullAccess: 'Si eliges "Acceso total", confírmalo con "Permitir acceso total".',
  back: "Volver",
  openSettings: "Abrir Ajustes",

  // OwnPhotos
  next: "Siguiente",

  // General
  confirm: "Confirmar",
  close: "Cerrar",

  // LanguageToggle
  changeLanguage: "Cambiar idioma",

  // WinnerModal singular
  pointsOne: "{points} punto",

  // WaitingRoom: player gone (disconnected past the server's grace)
  playerDisconnected: "desconectado",

  // WaitingRoom / GameScreen: tag next to your own name in player lists
  you: "Tú",

  // GameScreen: shown next to a player's name when they take a screenshot
  tookScreenshot: "hizo una captura",
} as const;
