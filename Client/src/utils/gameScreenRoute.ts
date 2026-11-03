// ── Game screen route ──
// The lobby opens the game screen in two ways: at the start of a game (game-started), or on a game already in
// progress (a rejoin: the lobby got its snapshot). In the first case it gets game-started's game number, so it knows
// its game before any round event (EXP-384). In the second case the screen asks again for the server's snapshot
// and must not paint the ready phase ("are you ready?") until it says which phase the game is in (EXP-289).

import { NO_GAME_NUMBER } from "./roundState";

export const GAME_SCREEN_PATH = "/screens/GameScreen";
/**
 * The game screen's route name in the root stack (its navigation state), e.g. under an invite link's waiting room. A
 * root stack route is named after its file under app/, i.e. its path without the leading slash, as long as no
 * _layout.tsx nests a navigator in app/screens (gameScreenRoute.test checks app/_layout.tsx declares it).
 */
export const GAME_SCREEN_ROUTE_NAME = GAME_SCREEN_PATH.slice(1);

export type GameScreenParams = { resync?: string; gameNumber?: string };

/** The game screen at the start of game `gameNumber` (game-started's third argument) */
export const gameScreenAtStart = (gameNumber: number) =>
  ({ pathname: GAME_SCREEN_PATH, params: { gameNumber: String(gameNumber) } }) as const;

/**
 * The game number the screen was opened with (gameScreenAtStart); NO_GAME_NUMBER without one (opened on a game in
 * progress: its snapshot says which game it is)
 */
export const openingGameNumber = (params: GameScreenParams): number => {
  const gameNumber = Number(params.gameNumber);
  return Number.isInteger(gameNumber) && gameNumber > NO_GAME_NUMBER ? gameNumber : NO_GAME_NUMBER;
};

/** The game screen on a game in progress: it waits for the server's snapshot before painting a phase */
export const RESYNC_GAME_SCREEN = { pathname: GAME_SCREEN_PATH, params: { resync: "1" } } as const;

export const opensOnGameInProgress = (params: GameScreenParams): boolean => params.resync === "1";
