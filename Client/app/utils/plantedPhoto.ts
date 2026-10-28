import type { Room } from "../models/interfaces";

type PlantWindow = Pick<Room, "phase" | "round">;

/**
 * The server takes planted photos until round 1 is actually played: in the lobby and the ready phase (no phase yet),
 * and while round 1's photo is still awaited. Same rule as the server's `acceptsPlantedPhoto`
 * (Server/middlewares/uploadAccess.ts).
 */
export const acceptsPlantedPhoto = ({ phase, round }: PlantWindow): boolean =>
  phase === null || (phase === "waiting-photo" && round === 0);

export interface ReplantCheck {
  /** The room as the rejoin's `room-of-game` describes it. */
  room: PlantWindow & Pick<Room, "started">;
  /** The server's own mark: it has a planted photo of mine. */
  hasPlantedPhoto: boolean;
  /** Photo picked in the lobby to plant in this game. */
  plantedPhotoUri: string | null;
  /** This device sent plant-photo for it. */
  plantedPhotoSent: boolean;
}

/**
 * After an in-game rejoin: plant the picked photo again when the server doesn't have it (its upload ended offline or
 * before the rejoin bound the new socket to the room, so GameContext never sent it; or it failed) and the game still
 * takes planted photos.
 * - Only inside a started game: after game over the room also has no phase, but `started` is false and the marks are
 *   cleared; planting then would put this game's photo into the next one.
 * - Before the planted rounds are drawn (ready phase, no phase yet) the server's mark is the truth.
 * - Once round 1's wait has started, a photo this device did send may be missing because it is the one being played
 *   (its mark is cleared when its wait starts): planting it again would show it twice, so only a photo never sent is
 *   planted then (GameContext only counts it as sent once emitted on a socket bound to the room).
 */
export const shouldReplantAfterRejoin = ({ room, hasPlantedPhoto, plantedPhotoUri, plantedPhotoSent }: ReplantCheck): boolean => {
  if (!plantedPhotoUri || hasPlantedPhoto || room.started !== true || !acceptsPlantedPhoto(room)) return false;
  return room.phase === null || !plantedPhotoSent;
};
