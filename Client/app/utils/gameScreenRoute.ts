// ── Game screen route ──
// The lobby opens the game screen in two ways: at the start of a game (game-started), or on a game already in
// progress (a rejoin: the lobby got its snapshot). In the second case the screen asks again for the server's snapshot
// and must not paint the ready phase ("are you ready?") until it says which phase the game is in (EXP-289).

export const GAME_SCREEN_PATH = "/screens/GameScreen";
/** The game screen's route name in the root stack (its navigation state), e.g. under an invite link's waiting room */
export const GAME_SCREEN_ROUTE_NAME = "screens/GameScreen";

export type GameScreenParams = { resync?: string };

/** The game screen on a game in progress: it waits for the server's snapshot before painting a phase */
export const RESYNC_GAME_SCREEN = { pathname: GAME_SCREEN_PATH, params: { resync: "1" } } as const;

export const opensOnGameInProgress = (params: GameScreenParams): boolean => params.resync === "1";
