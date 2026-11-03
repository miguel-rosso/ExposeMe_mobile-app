import fs from "fs";
import path from "path";
import {
  GAME_SCREEN_PATH, GAME_SCREEN_ROUTE_NAME, gameScreenAtStart, openingGameNumber, RESYNC_GAME_SCREEN,
} from "../src/utils/gameScreenRoute";
import { NO_GAME_NUMBER } from "../src/utils/roundState";

// EXP-368: the waiting room recognises the game screen under it by its route name in the root stack (EXP-363). That
// name is derived from the screen's path, which only holds while app/_layout.tsx's Stack declares it as is and no
// nested layout under app/screens turns it into a route of another navigator: these checks fail if either changes.

const APP_DIR = path.join(__dirname, "..", "app");
const SCREENS_DIR = path.join(APP_DIR, "screens");
const LAYOUT_FILE_RE = /(^|[\\/])_layout\.[jt]sx?$/;

const rootLayoutSource = () => fs.readFileSync(path.join(APP_DIR, "_layout.tsx"), "utf8");
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const layoutsUnder = (dir: string) =>
  fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) => LAYOUT_FILE_RE.test(file));

describe("game screen route name (EXP-368)", () => {
  it("is the game screen's file under app/, which its path opens", () => {
    expect(fs.existsSync(path.join(APP_DIR, `${GAME_SCREEN_ROUTE_NAME}.tsx`))).toBe(true);
    expect(`/${GAME_SCREEN_ROUTE_NAME}`).toBe(GAME_SCREEN_PATH);
  });

  it("is declared by the root Stack in app/_layout.tsx", () => {
    const declaration = new RegExp(`<Stack\\.Screen\\s+name="${escapeRegExp(GAME_SCREEN_ROUTE_NAME)}"`);
    expect(rootLayoutSource()).toMatch(declaration);
  });

  it("is not nested in another navigator: no _layout under app/screens", () => {
    expect(layoutsUnder(SCREENS_DIR)).toEqual([]);
  });
});

// EXP-384: the lobby opens the game screen from game-started with that game's number, so the screen knows its game
// before any round event
describe("game screen opened from game-started (EXP-384)", () => {
  it("carries the game's number to the screen", () => {
    expect(gameScreenAtStart(3)).toEqual({ pathname: GAME_SCREEN_PATH, params: { gameNumber: "3" } });
    expect(openingGameNumber(gameScreenAtStart(3).params)).toBe(3);
  });

  it("knows no game number when opened without one (on a game in progress) or with a malformed one", () => {
    expect(openingGameNumber({})).toBe(NO_GAME_NUMBER);
    expect(openingGameNumber(RESYNC_GAME_SCREEN.params)).toBe(NO_GAME_NUMBER);
    for (const gameNumber of ["", "0", "-1", "1.5", "abc", "undefined"]) {
      expect(openingGameNumber({ gameNumber })).toBe(NO_GAME_NUMBER);
    }
  });
});
