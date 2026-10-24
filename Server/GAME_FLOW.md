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

## Disconnected players

- A socket disconnect keeps the player in the room (they can rejoin with the same username) but marks
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
| `game-started` | - | `players, rounds` | Navigate to game screen |
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
| `im-ready` | `{ gameCode, username }` | Player ready to start |
| `photo-sent` | `{ photo, gameCode }` | Photo uploaded |
| `submit-answer` | `{ guess }` | Player's answer |
| `hold-start` | - | Photo owner pressed hold |
| `hold-end` | - | Photo owner released hold |
