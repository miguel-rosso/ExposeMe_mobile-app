# ExposeMe — Game Flow

## Server is the single source of truth

The server controls ALL timing. The client never runs its own game timers.
The client only reacts to server events and renders UI.

## Phases

```
LOBBY → start-game → im-ready (all) → first round

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
- Host only: `set-rounds` (lobby only), `start-game` (not while a game is running), `remove-player`.
- `im-ready` only counts between `game-started` and the first round (`started && phase === null`).
  `game-over` resets `isReady`, `started` and `phase` for every player.
- Player objects broadcast to others (`player-joined`, `game-started`, `new-host`, `player-removed`,
  `room-of-game.room.players`) never include `rejoinToken` or `plantedPhoto`.

## Disconnected players

- A socket disconnect keeps the player in the room (they can rejoin with the same username and their
  `rejoinToken`) but marks
  them `connected: false`; rejoining marks them `connected: true` again.
- Each round's photo owner is picked only among **connected** players.
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
| `photo-sent` | `{ photo }` | Photo uploaded; only from the current owner, `photo` must be a `/upload` path (`/temp/<digits>-<name>`) |
| `submit-answer` | `{ guess }` | Player's answer |
| `hold-start` | - | Photo owner pressed hold |
| `hold-end` | - | Photo owner released hold |
| `chat-message` | `{ message }` (≤100 chars) | Broadcast as `{ username, message }` with the session username |
| `emoji-reaction` | `{ emoji }` (≤16 chars) | Broadcast as `{ username, emoji }` with the session username |
| `plant-photo` / `mark-player-planted` | `{ photoUrl }` / - | Applies to the session player; `photoUrl` must be a `/upload` path |

Payload `gameCode`/`username` fields are ignored for all of the above; identity comes from the session.
