# ExposeMe — Game Flow

## Server is the single source of truth

The server controls ALL timing. The client never runs its own game timers.
The client only reacts to server events and renders UI.

## Phases

```
LOBBY → start-game → im-ready (every connected player, ≥2 connected, or 10s timeout) → first round (after 1s)

Each round:
  ┌─ waiting-photo ──→ (player uploads) ──→ answering ──→ reveal ──→ scores ──→ next round
  │                                          (8s)         (3s)       (5s)
  │  If upload fails after 15s:
  │  └─ round-skipped ──→ next round (same round number, no penalty)
  └──────────────────────────────────────────────────────────────────────────────

After last round: game-over
```

## Join, rejoin and session

- `join-create-game { gameCode, username, rejoinToken? }`: `gameCode: null` creates a room (sender is host).
  `username` must be a string, 1–20 chars and not blank.
- On success the server answers **only to that socket** with
  `room-of-game { success, room, rounds?, rejoinToken }`. `rejoinToken` is a random secret per player
  (base64url, 18 bytes) that is never included in any other payload; clients keep it (the app stores it in
  AsyncStorage with the game code and username) to reconnect.
- Joining with a username that already exists in the room is a **rejoin** and requires the matching
  `rejoinToken` (compared in constant time). Without it the join is rejected with
  `"Username already taken"` (lobby) or `"Game already started"` (game in progress). A rejoin returns the
  same token, rebinds the player to the new socket and does not broadcast `player-joined`.
- A successful join binds the socket to `(gameCode, username)` server-side. **Every other event uses that
  session**: `gameCode`/`username` fields in payloads are ignored (still accepted for compatibility).
  Events from sockets that never joined, or that were replaced by a rejoin on another socket, are ignored
  (a replaced socket's `leave-room` only detaches that socket; the live player stays). After `leave-room`
  the username is free again, so joining with it needs no token.
- **One socket = one player in one room.** The same live socket re-sending `join-create-game` for the room
  and username it is already bound to (e.g. the WaitingRoom effect re-running, a duplicate join) is a no-op:
  same `room-of-game` answer with the same token, no token needed, no broadcast. Reconnects arrive on a
  **new** socket and go through the normal rejoin path with the `rejoinToken`.
- Any other `join-create-game` from a bound socket (another room, a new room, or the same room under another
  username) is attempted first; **only if it succeeds** is the previous binding left exactly like
  `leave-room` (player removed, host handed over, `player-left`, socket leaves the socket.io room). A failed
  join leaves the socket where it was. Switching username inside the same room frees the socket's own slot
  for the capacity check.
- A room holds at most **12 players** (`MAX_PLAYERS_PER_ROOM`); new players beyond that get
  `"Room is full"`. Rejoins of existing players are always accepted.
- Limits: at most **5 `join-create-game` per socket in any 10 s** (excess answered with
  `{ success: false, message: "Too many attempts" }`), and at most **5000 rooms** in memory (`MAX_ROOMS`;
  creating beyond it answers `"Server is busy"`, joining existing rooms still works).
- Host only: `set-rounds` (lobby only), `start-game` (not while a game is running), `remove-player`.
- `im-ready` only counts between `game-started` and the first round (`started && phase === null`).
  The first round is scheduled (after `GAME_START_DELAY`, 1 s) as soon as **at least 2 players are connected
  and all connected players are ready** (checked on `im-ready` and when a player disconnects, leaves or is
  removed during this phase), or after **10 s** (`READY_TIMEOUT`, started by `start-game`) with whoever is
  ready, so a player who
  backgrounds the app or drops before the game screen mounts can't block the game. The photo owner is still
  picked only among connected players (ready or not); later `im-ready`s are ignored. If fewer than 2 players
  are connected by then, the game ends (`game-over`).
  `game-over` resets `isReady`, `started` and `phase` and clears unused planted photos
  (`plantedPhoto`, `hasPlantedPhoto`) for every player; `start-game` resets `points`, `lastGuess` and
  `lastAnswerCorrect` ("Play again" in the same room starts from zero).
- Player objects broadcast to others (`player-joined`, `game-started`, `new-host`, `player-removed`,
  `room-of-game.room.players`) never include `rejoinToken` or `plantedPhoto`.

## Disconnected players

- A socket disconnect keeps the player in the room (they can rejoin with the same username and their
  `rejoinToken`) but marks
  them `connected: false`; rejoining marks them `connected: true` again.
- Each round's photo owner is picked only among **connected** players.
- When no connected player is left (everyone disconnected, or the last connected one left), the room is
  deleted after **30 min** (`ROOM_CLEANUP_DELAY`), or **2 min** if it never had a second player, unless
  someone successfully rejoins/joins first (rejected joins do not postpone the deletion). A running game in such a
  room ends at the next round boundary (below), so no game timers outlive it; deleting a room clears its timers.
- If fewer than 2 players are connected at a round boundary, the server ends the game (`game-over`).
- Photo-wait timeouts skip the round (`round-skipped`), but after **3 consecutive skips**
  (`MAX_CONSECUTIVE_SKIPS`) the server ends the game (`game-over`) instead of skipping forever.
  Any round that is actually played (uploaded or planted photo) resets the counter.

## Hold (pause)

- Available to the photo owner during `reveal` and `scores` phases
- Press: game pauses for everyone (server stops timer)
- Release: game resumes from where it paused
- No time limit on hold
- Safety: server force-releases after 30s if client never sends release

## Events (Server → Client)

All game events are **atomic** — each contains everything the client needs.

| Event | Phase | Data | Description |
|-------|-------|------|-------------|
| `room-of-game` | - | `{ success, room?, rounds?, message?, rejoinToken? }` | Join result (token only to the joiner) |
| `game-started` | - | `players, rounds` | Navigate to game screen (players without `rejoinToken`/`plantedPhoto`) |
| `your-turn` | waiting-photo | `{ round }` | You must pick and upload a photo |
| `round-start` | answering | `{ photo, owner, round, duration }` | Show photo, start answer timer |
| `round-reveal` | reveal | `{ correctAnswer, duration }` | Show correct answer |
| `round-scores` | scores | `{ scores, duration }` | Show scoreboard |
| `hold-start` | - | - | Pause everything visually |
| `hold-resume` | reveal/scores | `{ phase, duration }` | Resume with remaining time |
| `round-skipped` | - | - | Upload timed out, next player |
| `game-over` | - | `{ finalScores }` | Show final results |

## Events (Client → Server)

| Event | Data | Description |
|-------|------|-------------|
| `join-create-game` | `{ gameCode \| null, username, rejoinToken? }` | Create/join; rejoin needs `rejoinToken` |
| `set-rounds` | `{ rounds }` (10/15/20) | Host only, lobby only |
| `start-game` | - | Host only |
| `im-ready` | - | Player ready to start (session player; payload ignored) |
| `photo-sent` | `{ photo }` | Photo uploaded; only from the current owner, `photo` must be a `/upload` path (`/temp/<32 hex>.jpg\|png\|webp`) |
| `submit-answer` | `{ guess }` | Player's answer |
| `hold-start` | - | Photo owner pressed hold |
| `hold-end` | - | Photo owner released hold |
| `chat-message` | `{ message }` (≤100 chars) | Broadcast as `{ username, message }` with the session username |
| `emoji-reaction` | `{ emoji }` (≤16 chars) | Broadcast as `{ username, emoji }` with the session username |
| `plant-photo` / `mark-player-planted` | `{ photoUrl }` / - | Applies to the session player; `photoUrl` must be a `/upload` path |

Payload `gameCode`/`username` fields are ignored for all of the above; identity comes from the session.

## Photo upload (HTTP)

`POST /upload` (multipart, one file in field `image`, ≤10MB) → `200 { url: "/temp/<32 random hex>.<jpg|png|webp>" }`, served from `/temp` for 30 min.
- Accepted formats: JPEG, PNG, WebP, detected from the file contents (the file name and declared MIME type are ignored). The app is expected to send JPEG; HEIC and anything else is refused.
- The stored image is re-encoded: orientation applied, scaled down to fit 2048×2048, all metadata (EXIF incl. GPS, XMP, ICC) removed, same format as the input.
- Images are processed one at a time with a short bounded queue (`controllers/sanitizeImage.ts`).
- Errors are JSON `{ error }`:

| Status | When |
|--------|------|
| 400 | No file, malformed multipart, more than one file, wrong field, undecodable image |
| 413 | File over 10MB, or image over 24 megapixels |
| 415 | Not JPEG/PNG/WebP (e.g. HEIC) |
| 429 | Per-IP rate limit (`Retry-After`) — default 60 uploads/min, env `UPLOAD_RATE_MAX` / `UPLOAD_RATE_WINDOW_MS`; `qa/lab/lab.sh server` raises it for bot load tests |
| 503 | Server busy processing other uploads (`Retry-After`) |

Behind a reverse proxy, env `TRUST_PROXY` is the number of proxy hops used to read the client IP (default 1 when `RENDER` is set, otherwise 0). Env `UPLOAD_DIR` overrides the storage directory (default `Server/temp`).
