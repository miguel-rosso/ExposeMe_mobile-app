// ── Credentials for the server's photo endpoints ──
// POST /upload and GET /temp/<photo> only answer members of the photo's room: every request carries the room code
// and the player's rejoin token (from room-of-game) as headers. Never put the token in a URL or a log line.

export interface PhotoAuth {
  gameCode: string;
  token: string;
}

export const GAME_CODE_HEADER = "X-Game-Code";

export const photoAuthHeaders = (auth: PhotoAuth): Record<string, string> => ({
  Authorization: `Bearer ${auth.token}`,
  [GAME_CODE_HEADER]: auth.gameCode,
});

/** Session credentials for an upload; throws (→ the upload counts as failed) when there is no token. */
export const resolvePhotoAuth = async (
  getRejoinToken: (gameCode: string, username: string) => Promise<string | null>,
  gameCode: string | null,
  username: string | null,
): Promise<PhotoAuth> => {
  const token = gameCode && username ? await getRejoinToken(gameCode, username) : null;
  if (!gameCode || !token) throw new Error("Upload failed: no session");
  return { gameCode, token };
};
