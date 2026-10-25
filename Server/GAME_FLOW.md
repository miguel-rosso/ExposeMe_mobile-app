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
  same token, rebinds the player to the new socket and does not broadcast `player-joined`. Every other socket
  still bound to that player in the room (the replaced one, if still alive) is **evicted**: removed from the
  socket.io room, session cleared and disconnected, so it receives no more room events (e.g. photo URLs).
- A successful join binds the socket to `(gameCode, username)` server-side. **Every other event uses that
  session**: `gameCode`/`username` fields in payloads are ignored (still accepted for compatibility).
  Events from sockets that never joined, or that were replaced by a rejoin on another socket, are ignored
  (a replaced socket's `leave-room` only detaches that socket; the live player stays). After `leave-room`
  the username is free again, so joining with it needs no token.
- **One socket = one player in one room.** The same live socket re-sending `join-create-game` for the room
  and username it is already bound to (e.g. the WaitingRoom effect re-running, a duplicate join) is a no-op:
  same `room-of-game` answer with the same token, no token needed, no broadcast. If the game has started it
  also sends that socket a fresh **`game-state` snapshot** (plus `your-turn` if its photo is awaited and the game
  is not paused), with no other effect: the app uses it to resync after rejoining from the lobby screen (see
  "Pause and reconnect"). Reconnects arrive on a **new** socket and go through the normal rejoin path with the
  `rejoinToken`.
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
- Host only: `set-rounds` (lobby only), `start-game` (not while a game is running), `remove-player`
  (evicts every socket bound to the removed player in that room, like a rejoin evicts the replaced one).
- `im-ready` only counts between `game-started` and the first round (`started && phase === null`).
  The first round is scheduled (after `GAME_START_DELAY`, 1 s) as soon as **at least 2 players are connected
  and all connected players are ready** (checked on `im-ready` and when a player disconnects, leaves or is
  removed during this phase), or after **10 s** (`READY_TIMEOUT`, started by `start-game`) with whoever is
  ready, so a player who
  backgrounds the app or drops before the game screen mounts can't block the game. The photo owner is still
  picked only among connected players (ready or not); later `im-ready`s are ignored. If fewer than 2 players
  are connected by then, the game pauses (see "Pause and reconnect" below).
  `game-over` resets `isReady`, `started` and `phase` and clears unused planted photos
  (`plantedPhoto`, `hasPlantedPhoto`) for every player; `start-game` resets `points`, `lastGuess` and
  `lastAnswerCorrect` ("Play again" in the same room starts from zero).
- Player objects broadcast to others (`player-joined`, `game-started`, `new-host`, `player-removed`,
  `room-of-game.room.players`) never include `rejoinToken` or `plantedPhoto`.

## Disconnected players

- A socket disconnect keeps the player in the room (they can rejoin with the same username and their
  `rejoinToken`) but marks
  them `connected: false`; rejoining marks them `connected: true` again.
- A client that silently loses network is detected by the socket.io heartbeat within
  `PING_INTERVAL + PING_TIMEOUT` (**10 s + 15 s**, `Server/app.ts`), overridable with
  `SOCKET_PING_INTERVAL_MS` / `SOCKET_PING_TIMEOUT_MS` (clamped to 1 s..300 s).
- Each round's photo owner is picked only among **connected** players.
- When no connected player is left (everyone disconnected, or the last connected one left), the room is
  deleted after **30 min** (`ROOM_CLEANUP_DELAY`), or **2 min** if it never had a second player, unless
  someone successfully rejoins/joins first (rejected joins do not postpone the deletion). A running game in such a
  room pauses and ends when the pause expires (5 min, below), so no game timers outlive it; deleting a room
  clears its timers.
- Photo-wait timeouts skip the round (`round-skipped`), but after **3 consecutive skips**
  (`MAX_CONSECUTIVE_SKIPS`) the server ends the game (`game-over`) instead of skipping forever.
  Any round that is actually played (uploaded or planted photo) resets the counter.

## Pause and reconnect

Short absences (app in the background, brief signal loss) are silent: socket.io reconnects on a **new** socket,
the client re-sends `join-create-game` with its `rejoinToken`, and the server answers the rejoin with
`room-of-game` followed by a **`game-state` snapshot** to that socket only (always on a rejoin, also in the lobby,
where it is ignored). The snapshot is taken after the rejoin's effect on a pause (resume), so it is never stale. The client keeps the game screen meanwhile and shows a small "Reconnecting…" indicator.

Rejoining from the lobby screen (the app was closed and the player uses "Join" again with their stored
`rejoinToken`): the WaitingRoom gets `room-of-game` + a `game-state` with `started: true`, opens the game screen
and, once the game screen listens, re-sends `join-create-game` on the **same** socket; the server answers with a
fresh snapshot (and `your-turn` for an awaited photo), which the game screen renders like any reconnect. Events
that reached the lobby screen in between are covered by that snapshot.

- **`game-state`** = `{ started, phase, round, totalRounds, owner, photo, correctAnswer, duration, held, pause,
  scores, players }`. `duration` is the remaining time of the current phase (frozen while paused/held). `owner`
  and `photo` are only set in `answering`/`reveal`/`scores` (the owner stays secret while waiting for a photo);
  `correctAnswer` only in `reveal`/`scores`. `pause` is `{ duration, waitingFor, pause, maxPauses }` (same as `game-paused`) while paused, else `null`.
  `started: false` means the game ended while the player was away (`scores` are the final scores).
  Until `round-scores` (phases `waiting-photo`/`answering`/`reveal`), `scores` and `players` hide this round's
  answers: `lastGuess: ""`, `lastAnswerCorrect: false` and `points` without the point a correct answer earned.
  The client renders that phase; in `reveal` it submits its guess (the missed `round-reveal` triggers that
  normally); with `phase: null` (ready phase) it sends `im-ready` again.
- The photo owner who rejoins while their photo is awaited gets `your-turn` again (same round number); the
  client re-sends the photo it already uploaded for that round instead of uploading a new one.
- **Pause**: mid-game (after the ready phase), when fewer than 2 players are connected (on a disconnect,
  leave or removal, or at a round boundary) and someone who dropped could still return, the server
  **pauses**: the phase timer is frozen (an active hold ends with `hold-end`; no hold while paused), photos
  sent while paused are ignored, and `game-paused { duration, waitingFor, pause, maxPauses }` goes to the room.
  Every connected client shows the countdown from that `duration` and "pause N of M" (`pause` of `maxPauses`;
  on the last one, a warning that the game ends if nobody returns).
- **Pause limit**: every pause gets a full `PAUSE_TIMEOUT` (5 min) countdown (`duration` 300000), but there are
  at most `MAX_PAUSES` (**3**) counted pauses per game (`pause` is 1, 2, 3). A pause that resumes less than
  `PAUSE_GRACE` (**10 s**) after it started is **refunded**: it doesn't count, so short drops (answering a message,
  flaky network) don't use up the game's pauses. Since that is only known at resume time, `pause` is always the
  would-be number of the pause in progress (counted pauses + 1); after a refund the next pause shows the same
  number again (`pause` may repeat, but never goes back below the counted pauses). On top of that there are at
  most `MAX_TOTAL_PAUSES` (**10**) pauses per game, counted or not, so a flapping connection can't freeze a game
  indefinitely. When a pause would exceed either cap (a 4th counted one, or an 11th in all) the game ends at once
  (`game-over`, no `game-paused`). "Play again" starts with no pauses used.
  If the players who are gone left for good (nobody disconnected remains), the game ends right away instead,
  also while already paused. While paused, when the list of awaited players changes (someone awaited leaves
  or is removed) `game-paused` is sent again with the new `waitingFor` and the remaining `duration` (same pause, same `pause` number).
- **Resume**: as soon as 2 players are connected again (a rejoin), but never before the pause lasted
  **2 s** (`PAUSE_MIN_DURATION`; an earlier rejoin schedules the resume, a new drop cancels it), the server sends
  `game-resumed { phase, duration }` and the frozen phase continues with its remaining time (at least 1.5 s;
  at least 5 s when waiting for a photo, and the owner gets `your-turn` again). A pause at a round boundary
  resumes by starting that round (new owner, same round number). Scores and round numbers are untouched.
- **Expiry**: when a pause's countdown runs out, `game-over`.
- With 2 or more players connected the game goes on without the missing ones (never picked as photo owner).
- Disconnect detection depends on the socket.io heartbeat (`pingInterval` + `pingTimeout`), unless the client
  closes the socket itself; a player whose loss the server hasn't noticed yet is still "connected", and a
  rejoin before that just rebinds the player to the new socket (the old socket's disconnect is ignored).

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
| `game-paused` | any | `{ duration, waitingFor, pause, maxPauses }` | Fewer than 2 connected: freeze, show countdown and "pause N of M" |
| `game-resumed` | any | `{ phase, duration }` | Paused phase continues with remaining time |
| `game-state` | any | snapshot (see "Pause and reconnect") | Only to a rejoining socket (or one re-sending its join in a started game): render current phase |
| `game-over` | - | `{ finalScores }` | Show final results |

## Events (Client → Server)

| Event | Data | Description |
|-------|------|-------------|
| `join-create-game` | `{ gameCode \| null, username, rejoinToken? }` | Create/join; rejoin needs `rejoinToken` (also after every reconnect in game) |
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

`POST /upload` (multipart, one file in field `image`, ≤10MB) → `200 { url: "/temp/<32 random hex>.<jpg|png|webp>" }`, served from `/temp` for 30 min (`UPLOAD_TTL_MS`, by file mtime: a sweep at startup and every 5 min deletes expired uploads and schedules exact deletion for those expiring before the next sweep, so restarts don't leave photos behind). Only `GET/HEAD /temp/<32 hex>.<jpg|png|webp>` is served (`Cache-Control: no-store, private`); expired or any other path under `/temp` → 404.
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
