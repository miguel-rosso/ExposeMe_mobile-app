# ExposeMe — Game Flow

## Server is the single source of truth

The server controls ALL timing. The client never runs its own game timers.
The client only reacts to server events and renders UI.

## Phases

```
LOBBY → start-game → im-ready (every connected player, ≥2 connected, or 10s timeout) → first round (after 1s)

Each round:
  ┌─ waiting-photo ──→ (player uploads) ──→ answering ──→ reveal ──→ scores ──→ next round
  │     (≤15s)                               (8s)         (3s)       (5s)
  │  No photo after 15s, or the owner sends photo-unavailable:
  │  └─ round-skipped ──→ next round (same round number, no penalty)
  │  The owner leaves, or stays disconnected 3s:
  │  └─ waiting-photo again for the same round, another player picked (no round-skipped; 2 free per player/game)
  └──────────────────────────────────────────────────────────────────────────────

After last round: game-over
```

## Waiting for the photo

- When a player is picked to send the photo, the server emits **`waiting-photo { round, duration }`** to the
  **whole room** (owner included, identical payload, so it never tells who was picked), and then
  **`your-turn { round, attempt }`** to the picked player only. `round` is the round about to be played
  (`room.round + 1`), `duration` the wait (`PHOTO_WAIT_TIMEOUT`, 15 s). `attempt` identifies this photo request: a
  new integer for every `waiting-photo` in the room, planted ones included (so it counts exactly the photo waits and
  never tells whether an earlier wait was planted; it changes even when the round number repeats after a skip or an
  owner change, also if the same player is picked again); re-sends of the same request (rejoin, resume) carry the same
  `attempt`.
  Every client shows "someone is choosing a photo" with a progress bar of that `duration`, **the owner's too**: the
  app picks and uploads the photo for `your-turn` in the background, with no different text or timing on screen, so
  the owner can't tell it's their turn (see "Whose photo it is").
- If the owner can't provide a photo (no gallery access, no photos, upload failed after retries; a photo that can't
  be converted is replaced by another pick, up to 3, within the photo wait) the client sends
  **`photo-unavailable { round, attempt }`**, echoing the `your-turn` it answers. It is accepted only from the
  session player who is the awaited owner, in `waiting-photo`, not while paused, and only when both are integers
  equal to the request in force; anything else (late report for an earlier request, duplicate, malformed) is
  ignored. The round is skipped at once. The app also drops the result of a your-turn flow whose request ended
  (next `waiting-photo`, `round-start`, `round-skipped`, `game-paused`, `game-state`, `game-over`): it neither sends
  that photo nor reports it unavailable (a photo uploaded meanwhile is re-sent if the same request is asked again).
- Every skip is announced with **`round-skipped { round, reason }`**, `reason` = `"timeout"` (no photo in 15 s, or
  every player went away as its owner, below) or `"unavailable"` (owner reported photo-unavailable); it never names
  the owner. The next round (same number) follows right away with a new `waiting-photo`. After an `"unavailable"`
  skip the same player is not picked for the next attempt when another connected player can be.
- **The owner goes away** (DEC-035; while the game runs, not paused): the owner *goes away* when they leave the
  room (`leave-room`, removed by the host) or stay disconnected for **3 s** (`OWNER_RETURN_WINDOW`; a brief flap goes
  unnoticed, and an owner back in time gets `your-turn` again and keeps the rest of the wait; a later drop gets a
  whole new window). The round is then **not skipped**: another connected player is picked for the **same round**
  right away, with the normal events (a new room-wide `waiting-photo { round, duration: 15 s }` with the same
  `round`, then `your-turn` with a new `attempt` to the new owner only; no `round-skipped`), so the others don't sit
  through the rest of the 15 s and the round isn't lost. The round number doesn't advance, so the game still plays
  its configured number of rounds. Each player is picked at most once per round this way (an earlier owner who came
  back isn't asked again for it). A pause in between cancels the 3 s window, and the resume starts it again if the
  owner is still away.
  - **Free owner changes** (anti-abuse, so players can't keep passing their turns on to steer every round onto
    someone): each player has **2 per game** (`MAX_FREE_OWNER_CHANGES`, by username, reset at each game start) that
    don't count toward the 3 consecutive skips that end the game. Once a player has used them, they get no 3 s
    window: when they disconnect as owner the normal 15 s wait applies and its timeout is a counted skip; if they
    leave, the round still goes to another player at once, but that counts as a skip.
  - When every connected player has already gone away as owner of that round, the round is played again from
    scratch: `round-skipped { reason: "timeout" }`, then a new `waiting-photo` with the same `round`, and anyone may
    be picked. That replay counts as a skip, so a round nobody keeps can't stall the game forever.
- **Planting.** The app uploads the chosen photo and sends `plant-photo` from the **lobby**, as soon as it is
  picked (uncropped, like the game's gallery photos), so `im-ready` never waits for it. Only if that upload failed
  does the game screen retry it, **after** `im-ready` (accepted until round 1 is played; a photo planted after the
  planted rounds were drawn gets a free later round). `plant-photo` is never emitted offline (socket.io would flush
  it on the new socket before the rejoin, where it is dropped), nor on a reconnected socket until its rejoin's
  successful `room-of-game` (until then the server drops it too): such a photo counts as not sent.
  `plant-photo` is **acknowledged**: `{ ok: true }` once it is the player's planted photo, else
  `{ ok: false, reason }` with `"not-in-room"` (socket bound to no room), `"invalid"` (no `/upload` path),
  `"too-late"` (round 1 already played, or the photo awaited now is the sender's own planted photo, unless it
  expired and that round will be skipped; checked before the photo) or `"photo-unavailable"` (no upload of this player in this room: expired, deleted as unclaimed after
  `UPLOAD_PLANT_CLAIM_MS`, or another player's, all the same answer so it never tells whether someone else's photo
  exists). No ack when dropped by the rate limit. The app counts the photo as sent only on
  `ok`; on `"photo-unavailable"` (e.g. the upload's answer came after the server deleted it, the app having been
  suspended) it uploads it once more and sends that one. No ack within 5 s (`PLANT_ACK_TIMEOUT_MS`), or the
  connection dropping while it waits, counts as not sent; an `ok` that still comes later on the same connection
  marks it planted (if that photo is still picked and not being planted again). On a rejoin whose
  `room-of-game.hasPlantedPhoto` is
  false while the room still accepts planted photos, the lobby and the game screen plant it again (the game screen
  only inside a started game: never after `game-over`, which also leaves no phase but clears the marks; once round 1's
  wait has started, only a photo the app has no `ok` for: an acked one may be the one being played, whose mark is
  cleared when its wait starts; one accepted whose ack was lost is refused as `"too-late"` if it is the one awaited,
  so it is never shown twice). Picking another photo replaces it. Whether a player planted
  one goes back only to that player (`room-of-game.hasPlantedPhoto`); there is no way to drop a planted photo.
- **Planted rounds look like any other round** (nobody can tell one was planted, nor by whom): the server sends
  the same room-wide `waiting-photo { round, duration: 15 s }`, sends **no `your-turn`** (not even to the planter),
  and after a hidden delay the usual room-wide `round-start`. The delay (`managers/plantedDelay.ts`) is drawn from a
  fixed distribution of realistic photo waits (log-normal, median 2 s, clamped to 0.8–6 s), mixed with the
  **planter's own** real waits in this room (`waiting-photo` → accepted `photo-sent` of their uploaded photos, the
  latest 3, each counted as at most 6 s), so the planted photo arrives like that player's uploads do: with n of them,
  one (±15 % jitter) is drawn with probability n / (n + 4). Nobody else's waits count: other rooms, the room's other
  players and players who left the room (their waits are forgotten) can't shift it; right after a server start, or for
  a planter with no upload yet, it is the fixed distribution, not a recognisable fixed range. The delay always ends
  at least 1 s before the 15 s countdown. During that wait the phase is `waiting-photo` with no owner picked: the
  planter can't send a photo nor `photo-unavailable`. Clients see the countdown of a normal 15 s wait (rejoin
  snapshot, `game-resumed`), never the hidden delay; a pause freezes both, and `game-resumed` continues from what the
  snapshot showed during the pause with the same minimum as a normal wait (at least 5 s, see "Pause and reconnect")
  and re-sends no `your-turn`. The photo then comes after what the pause left of the hidden delay, or after a quick
  re-send of 100–400 ms when less was left (as a resumed owner re-sends a photo already uploaded), at least 1 s before
  the countdown ends. If the planter left meanwhile it behaves like an owner who left: the
  planted photo is dropped and a connected player is picked for the same round at once (new `waiting-photo` with the
  same `round`, `your-turn` to the new owner, no `round-skipped`; it uses one of the planter's free owner changes, as
  for any owner); a planter who only disconnected changes nothing (the photo is already uploaded). If the photo
  expired during a pause, no photo comes and the round is skipped (`"timeout"`) when the countdown ends. The planted
  photo (`plantedPhoto`, `hasPlantedPhoto`) is cleared when its wait starts, so it is never shown twice.
- **Only connected planters are drawn.** A planted round draws among the planted photos of connected players (like
  the owners of uploaded photos). With none (every planter left is disconnected, within their grace), the round is
  played as a normal one, and a disconnected planter keeps their photo: it gets a random free later round (if one is
  left), where it is drawn if they are back by then. Nothing is sent about it.

## Whose photo it is (secret until the reveal)

- The photo owner (the uploader, or the planter for a planted photo) is never named before `round-reveal`
  (DEC-031: the owner may not recognise the photo, so they play too). **`round-start { photo, round, duration }`** is
  one room-wide payload, the same for every player, owner included, and so is the `game-state` snapshot (its only
  per-recipient field, `yourGuess`, is `null` before the reveal; its scores' order doesn't move with this round's
  answers either, see "Pause and reconnect").
  So the unmodified app never shows the owner anything before the reveal, and other players can't infer it. The
  owner's own client necessarily knows: it receives `your-turn` and uploads the photo (the round's photo path is the
  one its `/upload` returned), so this protects the game's fun, not against a modified owner client.
- The owner plays like everyone: the same answer options (their own name included) and the same scoring. Their
  `submit-answer` is recorded and scored like any other: **voting for yourself counts as a correct guess** (DEC-031).
  The planter of a planted photo is treated the same: their self-vote counts too (DEC-032).
- From `round-reveal { correctAnswer }` on, the answer is public (`round-scores`, snapshot `correctAnswer` in
  `reveal`/`scores`). That is also when the owner's app learns the photo was theirs (`correctAnswer` equals its own
  username): it then shows "It was your photo!" on the scoreboard and the hold button (see "Hold").

## Answers (frozen when answering ends)

- The client sends **`submit-answer { guess }`** as soon as the player taps an option, and again on every change
  (`""` withdraws the pick, e.g. when the picked player leaves). The server keeps the **last** one: each new guess
  replaces the previous one and its point.
- Answers are accepted **only in `answering`** (also while paused in it). The server freezes them when the answer
  timer ends, right before emitting `round-reveal`; anything that arrives in `reveal`/`scores` is ignored, since
  `correctAnswer` is public by then. The app sends nothing at the reveal.
- **`round-reveal { correctAnswer, duration, yourGuess }`** goes to each player separately: `correctAnswer` and
  `duration` are the same for everyone, `yourGuess` is the recipient's own answer as the server froze it (`""` = no
  guess), never anyone else's (the others' guesses stay hidden until `round-scores`). The app colours that pick, not
  its own last one: a change that left the phone but arrived after the freeze (high latency) never counted, and the
  reveal shows it didn't.
- **Grace for the last tap**: the answer timer is `ANSWER_TIME` (8 s), but every `duration` sent to clients for
  `answering` (`round-start`, `game-state`, `game-resumed`) is **`ANSWER_GRACE` (300 ms) less** than what is left of
  it. The app stops taking taps when its answer bar (drawn with that `duration`, not a separate game timer) ends,
  and the server keeps taking answers for ANSWER_GRACE after that, so every tap the app accepted arrives in time.
  The bar ends `duration` after the event **arrived on the device**, however late the phase is painted (a slow phone
  mounts the bar already partly full, EXP-300): only the delivery delay counts against the grace, never the paint.
- Only players still in `room.players` can be voted for: a guess naming someone who left (the owner included) or an
  unknown name is ignored and the previous pick stays.
- Rate limit: per socket, a token bucket of **10** `submit-answer`, refilled at **5 per second**; excess events are
  dropped silently. The bucket lives and dies with the socket. The app coalesces rapid taps (at most one send per
  200 ms, with a trailing send of the latest pick), so the limit never drops the pick that counts. When the answer
  bar ends, a pick still waiting is sent at once (within ANSWER_GRACE) and later taps are ignored.
- A rejoining client in `answering` re-sends its current pick of that round (one sent while offline was lost).
  As with the live events, a `reveal` snapshot colours the snapshot's `yourGuess` (the recipient's recorded answer)
  and a `scores` snapshot lists each player's `lastGuess`, so the colours match what the server recorded.
- There are no other answer events (the legacy `correct-answer` / `incorrect-answer` aliases were removed).

## Join, rejoin and session

- Connecting: every socket.io request (the handshake, each long-polling GET/POST of an open session, and the
  WebSocket upgrade) is accepted only without an `Origin` header (Node bots, React Native's polling) or with an
  `Origin` whose host equals the request `Host` (React Native's native WebSocket sends
  `http(s)://<server host>[:port]`). Any other `Origin` (another website, `null`) and JSONP polling (a `j` query
  parameter, which a cross-origin `<script>` could read) get **400** and no socket, since CORS doesn't cover
  WebSockets or JSONP (`middlewares/socketOrigin.ts`). This stops other websites from using their visitors' browsers
  as clients; it is not an authentication layer (any non-browser client can omit `Origin`).
  Optional env `ALLOWED_HOSTS` (comma-separated host names, ports ignored, e.g. `exposeme.onrender.com`): when set,
  every socket.io request must also carry one of those names in `Host` (**400** otherwise), so another domain pointed
  at the server's IP (DNS rebinding, which would send a matching `Origin`) is refused. Unset (the default), any `Host`
  is accepted. **Recommended in production**: set it to the public host name(s) of the deployment (on Render, the
  service's `*.onrender.com` name plus any custom domain); local and lab servers leave it unset.
- **New sessions per IP**: each IP may open at most **300 engine.io sessions per minute** (env
  `SOCKET_HANDSHAKE_RATE_MAX`; sliding 60 s window, same IP key as the other per-IP limits). Only handshakes count
  (polling or WebSocket requests without a `sid`), not the requests of an open session nor requests refused above;
  over the limit the handshake gets **400** and the client's `connect_error` (socket.io reconnects with backoff). This
  bounds the sessions a browser can open without ever joining (e.g. with `<img>` tags, which send no `Origin`).
- `join-create-game { gameCode, username, rejoinToken? }`: `gameCode: null` creates a room (sender is host).
  `username` (`managers/playerName.ts`) is free-form: any script, emoji, symbols, punctuation or ASCII art, also with
  no letter at all (`¯\_(ツ)_/¯`, `(•_•)`, `<3 <3`, `🔥🔥`). It must be a string of 1–20 chars (UTF-16 units) and at
  most 60 after NFKC (one Arabic ligature such as U+FDFA expands to 18 letters), not blank, with no combining mark at
  the start (after any leading spaces) or on a trailing space, at most four combining marks in a row (Tibetan and
  pointed Hebrew stack three; more is "Zalgo" text), and none of: controls, format characters (zero-width characters,
  bidi overrides/isolates, BOM), default-ignorable characters (fillers, variation selectors, combining grapheme
  joiner), private-use/unassigned code points, characters drawn blank (U+2800, U+16FE4, U+1D159, U+FFFC) or spaces
  other than U+0020 (no-break, ideographic, em...). Allowed where they belong: inside an emoji the zero-width joiner
  of a sequence (woman technologist), the emoji/text presentation selectors (red heart, keycaps) and the tags of a
  subdivision flag (England); the zero-width joiner and non-joiner between two letters of Arabic, Syriac or the Indic
  scripts and Sinhala (Persian half-space, Sinhala "Sri"). Letters that read as Latin (Latin ones, and those of other
  scripts listed in the confusables table below), with their accents dropped, may not come from two of the
  Latin-lookalike scripts (Latin, Greek, Cyrillic, Armenian, Cherokee, Lisu, Coptic), so `Dave` with a Greek nu,
  `Mike` with a Cyrillic small ka, `Dave` with a Greek alpha with tonos or a Greek alpha with a Cyrillic be is
  refused. Any other mix is free (`Li 李`, `Dave Ж`, `Σ(ﾟДﾟ)`, `(ノಠ益ಠ)ノ`). Otherwise: `"Invalid username"`. The name
  is stored and sent to everyone **exactly as typed** (the app compares its own typed name with the room's names).
- Names that read the same on screen can't share a room. Two keys are compared. `nameKey`: characters drawn like
  ASCII letters or digits replaced by them (a table generated from UTS #39 `confusables.txt` covering every script,
  symbol and spacing mark, plus the lowercase forms of letters it only lists as capitals, such as Cyrillic small ka;
  `managers/asciiConfusables.ts`, regenerated with `scripts/generateAsciiConfusables.mjs`), then NFKC, combining
  marks and accents dropped unless they sit on a space, the table again, case-folded, joiners dropped, whitespace
  trimmed and collapsed. The table runs before NFKC too, so long s still reads as `f`. `visualKey`: the same, but
  symbols drawn like other symbols read as their UTS #39 prototype first (a second table in the same file,
  `SYMBOL_CONFUSABLES`, applied before and after the skeleton because NFKC turns `¯`, `´` or `¸` into a space and a
  mark), then I / l / | / 1 read as `l`, `rn` as `m`, `vv` as `w`, `cl` as `d` and `0` as `o`. The symbol table
  leaves out what reads as a different name: a clearly different size (measured in Roboto and SF: `•` and `∙` apart
  from `·` and `・`, `○` and `◦` from `°`, `█` and `■` from `∎`, `–` and `−` from `-` and from `—`, `˜` from `~`,
  full-width `－` from `ー`), emoji (drawn in colour: `🍎` and `🍏`), combining and spacing marks (Indic and Khmer
  vowel signs: `डॉली` and `डाली`), symbols whose prototype is a cased letter (case folding would join `∑` with `∫`),
  and characters newer than Unicode 15.1 (the tables are generated with Node 20, the oldest the server supports,
  so they read the same on every Node). Known limits: only the groups common in kaomoji were measured, the rest
  follow UTS #39; `º`, `⁰` and `ᵒ` read as `°` in this key, so `bºb` no longer meets `b0b` (it is still the
  same name as `bob`). Both keys are taken from the name as stored and as drawn (`managers/displayOrder.ts`: the
  Unicode Bidirectional Algorithm via `bidi-js`, with the direction of the first strong letter, whole grapheme
  clusters moved (a letter keeps its marks) and brackets mirrored in right-to-left runs; so `Mi` followed by Hebrew
  samekh and vav, or by an Arabic-Indic five and a vav, reads `Milo`). Stored order is compared with stored
  order and drawn order with drawn order, so a right-to-left name never meets its own reversal. Each player's keys
  are computed once, when they join.
  - Same `nameKey` = the **same name**: with `bob` in the room, `bob `, `Bob`, full-width `bob`, `bob` with a dot
    below or `BOB` in Cyrillic capitals get `"Username already taken"`, and so do `Dave` written with a Latin small
    capital A or in Cherokee letters, `ᗅlice` (Canadian Syllabics) or `A│ice` (box drawing) next to `Alice`, `Raſe`
    next to `Rafe`, `Mike` in Cyrillic or Greek letters, `Bంb` (Telugu anusvara) next to `Bob`, `Mi` + Hebrew
    samekh and vav next to `Milo`, and `(•_•) ` or full-width `<3` next to `(•_•)` or `<3`. This holds even with the
    existing player's token: a rejoin needs the exact stored name.
  - Only the same `visualKey` = a **different name that looks too alike**: `AIice` next to `Alice`, `b0b` next to
    `bob`, real names such as `Clara` next to `Dara` or `Arnie` next to `Amie`, and symbol lookalikes such as
    `(∙_∙)` next to `(•_•)`, `ǃǃ` next to `!!`, `ˉ\_(ツ)_/ˉ` next to `¯\_(ツ)_/¯`, `(˚_˚)` or `(º_º)` next to `(°_°)`,
    `it’s` or `it´s` next to `it's`, `(一_一)` or `(—_—)` next to `(ー_ー)` get `"Username too similar"`, so
    the player knows the name isn't in use and only needs to differ more. Letters drawn like a capital I (Cyrillic
    І, Arabic alef) have the prototype `l` in UTS #39, so next to a name with I they also get `"Username too
    similar"` rather than `"Username already taken"`: both refuse the name.
  - Checked in this order: a valid rejoin (exact stored name and its token) first; then `"Game already started"`
    mid-game and `"Room is full"` at 12 players, **before** comparing names, so neither tells anything about the
    names in the room; then the two answers above.
- On success the server answers **only to that socket** with
  `room-of-game { success, room, rejoinToken, hasPlantedPhoto }`. `hasPlantedPhoto` is the joining
  player's own planted-photo mark (never sent about anyone else). `rejoinToken` is a random secret per player
  (base64url, 18 bytes) that is never included in any other payload; clients keep it (the app stores it in
  AsyncStorage with the game code and username) to reconnect.
- Joining with a username that already exists in the room is a **rejoin** and requires the matching
  `rejoinToken` (compared in constant time). Without it the join is rejected with
  `"Username already taken"` (lobby; `"Room is full"` if the room has 12 players) or `"Game already started"` (game
  in progress). A rejoin returns the
  same token, rebinds the player to the new socket and does not broadcast `player-joined`. Every other socket
  still bound to that player in the room (the replaced one, if still alive) is **evicted**: removed from the
  socket.io room, session cleared and disconnected, so it receives no more room events (e.g. photo URLs).
- A successful join binds the socket to `(gameCode, username)` server-side. **Every other event uses that
  session**: `gameCode`/`username` fields in payloads are ignored (still accepted for compatibility).
  Events from sockets that never joined, or that were replaced by a rejoin on another socket, are ignored
  (a replaced socket's `leave-room` only detaches that socket; the live player stays). After `leave-room`
  the username is free again, so joining with it needs no token.
- **Leaving** (Exit in the lobby or on the final screens, or an invite link to another room): the app sends
  `leave-room` with an ack callback and closes the socket **only once the server acks it** (it acks after removing
  the player), or after 1 s without an answer (`LEAVE_ACK_TIMEOUT_MS`, offline) so leaving never hangs; the app moves
  on at once. Closing in the same tick as the emit can lose the leave: socket.io dispatches an event on the next tick
  and drops it if the socket disconnected meanwhile, and the player would then be treated as a lost connection
  (lobby: shown as gone for 15 s with the name taken; mid-game: the game pauses for them instead of ending).
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
- **Room codes** are 6 characters from the 31-symbol alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (uppercase
  alphanumerics without the look-alikes 0/O and 1/I/L, ≈ 8.9e8 codes; e.g. `K7MQ4X`), each drawn with
  `crypto.randomInt` (not predictable from earlier codes) and unique among live rooms (`Server/managers/roomCode.ts`;
  the app uses the same alphabet in `Client/app/utils/roomCode.ts`). An incoming code is trimmed and uppercased, ASCII
  only (surrounding spaces/tabs/newlines, `a-z` → `A-Z`), so `" k7mq4x "` joins `K7MQ4X`; any non-ASCII character
  (e.g. `ß`, `ſ`, full-width digits, which a Unicode uppercase would turn into code letters) leaves it malformed; `gameCode` null or `""` creates a room instead. A code that is malformed after that
  (wrong length or a character outside the alphabet), matches no room, or is not a string answers `"Game not found"` and counts against the sender's **IP**: after
  **30 misses in any 60 s** (env `JOIN_MISS_MAX` / `JOIN_MISS_WINDOW_MS`) every join with a code from that IP answers
  `"Too many attempts"` whether the code exists or not, until the window clears. Exceptions: a rejoin with the
  matching `rejoinToken` (a reconnecting player is never locked out), and a join to a room that already has a
  connected player on the same IP (same network, e.g. the party Wi-Fi: it knows the code anyway), at most **24 per IP
  per window** (env `JOIN_EXEMPT_MAX`). Misses keep counting while locked; past **3 × `JOIN_MISS_MAX`** in the window
  the same-network exemption is dropped too (token rejoins only). A socket records at most one miss every 3 s, and
  for those 3 s after a miss its joins with a code answer `"Too many attempts"` without looking the code up (same
  exemptions), so every `"Game not found"` is a recorded miss (the app opens a new socket after a failed join anyway).
  Two coarser layers stop rotation across many addresses; both only tighten the limit of IPs that have misses of
  their own, so an IP with no misses in the window is never locked by others (except in a saturated /48, below):
  - every IPv6 miss also counts against its **/48**: while the /48 has **300 misses in the window** (env
    `JOIN_MISS_PREFIX_MAX`), each /64 in it is locked at **2 misses of its own** (and loses the same-network exemption
    at 6 own misses once the /48 has 3 × `JOIN_MISS_PREFIX_MAX`). IPv4 has no prefix layer.
  - a **global budget**: once **600 misses** (env `JOIN_MISS_GLOBAL_MAX`, counted only from IPs that weren't locked)
    land in one window, the server is under pressure and every IP's limit drops to **5 misses per window** (env
    `JOIN_MISS_PRESSURE_MAX`; 2 own misses in a /48 with 2 × that) until it clears. An attacker can trigger the
    pressure on purpose; it then only affects IPs with misses of their own (e.g. someone who mistyped a few codes),
    never IPs without misses, and token rejoins and same-network joins keep their exemptions.

  Misses are tracked for at most 50,000 IPs and 50,000 /48s (env `JOIN_MISS_MAX_TRACKED`; the least recently missing
  one is forgotten first), so rotating addresses can't grow memory without bound. A /48 with 300 misses in the window
  that itself holds at least 500 of the tracked IPs (the larger of `JOIN_MISS_PREFIX_MAX` and 1% of
  `JOIN_MISS_MAX_TRACKED`) when one of them is forgotten is rotating more addresses than are tracked (a /48 with fewer
  tracked IPs pushed out by someone else's rotation is not): it is **saturated** for one
  window (restarted each time another of its IPs is forgotten), and every join with a code from any IP in it answers
  `"Too many attempts"`, misses of its own or not (token rejoins and same-network joins keep their exemptions), so
  forgetting an IP never gives it its attempts back. Creating a room (`gameCode: null`) is
  not affected. `"Username already taken"`, `"Game already started"` and `"Room is full"` therefore only reach
  someone who already has a valid code. The client IP follows the same `TRUST_PROXY` hop count as Express (`req.ip`);
  per-IP limits count IPv4-mapped IPv6 (any notation) as IPv4 and IPv6 by its /64 prefix.
- **Connections**: at most **100 open sockets per IP** (env `SOCKET_MAX_CONNECTIONS_PER_IP`; a party shares one
  public IP and a reconnect can briefly overlap its stale socket), counted per transport connection until it closes.
  Beyond it the socket.io handshake fails with `connect_error` `"Too many connections"`, as does a second socket.io
  CONNECT on a transport connection that already has a socket (one socket per connection). `qa/lab/lab.sh server`
  lifts this and the join-miss limit for bots.
- **Game start drops gone players.** On every `start-game` (first game and "Play again"), each player who has been
  disconnected for longer than `DISCONNECT_GRACE` (**15 s**, see "Disconnected players") at that moment is removed
  from the room exactly like a leave: uploads released (planted photo
  included), host handed over if needed (`new-host`) and `player-left <username>` to the room, all before
  `game-started` (whose player list no longer has them). If fewer than 2 players are left, the start is refused
  (nothing else is emitted; the lobby shows the updated list). A removed player who comes back is a new player: their
  old `rejoinToken` no longer rejoins (`"Game already started"` while the game runs; in the lobby the name is free
  and they join fresh with a new token and 0 points). A player disconnected for less than the grace (a socket
  reconnecting right when the host presses Start) stays in the game: they rejoin normally, and if they don't come
  back the ready timeout and the pause logic below apply as for any mid-game disconnect.
- Host only: `set-rounds` (lobby only; 10/15/20, anything else is ignored, and so is the value the room already
  has: no `rounds-updated` for it. **QA-only:** 3 rounds is also accepted
  when the server runs with `ALLOW_QA_ROUNDS=1`, which `qa/lab/lab.sh server` sets for short device runs; it is off
  by default, so production rejects it, and the app never offers it), `start-game` (not while a game is running), `remove-player { username }`
  (by username, socket ids are never sent to clients; the host can't remove itself; evicts every socket bound to
  the removed player in that room, like a rejoin evicts the replaced one).
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
  The app keeps its socket open through `game-over` and the winner / final screens (the player stays connected
  and in the room, so lingering there never makes it "gone" nor hands the host role over): "Play again" re-sends
  `join-create-game` on that same socket (the no-op rejoin above), "Exit" sends `leave-room` and closes it (see
  "Leaving" above). The finished game screen stops listening to game events. **A next game started meanwhile takes
  the player in at once**
  (DEC-018 A): on `game-started` (or a `game-state` with `started: true`, e.g. after a reconnect) the final screens do
  what "Play again" does: back to the lobby, which re-sends `join-create-game` on the same socket, gets the snapshot
  of the started game and opens a fresh game screen that sends `im-ready`, so the ready phase is not left waiting the
  10 s `READY_TIMEOUT` for it. Should a `your-turn` still reach the final screens before that hand-over, it is
  answered at once with `photo-unavailable { round, attempt }` (no photo is ever picked from there).
- **Public player data.** Every player object sent to clients (`player-joined`, `game-started`, `new-host`,
  `player-removed`, `room-of-game.room.players`, `game-state.players`) is built by one allowlist
  (`RoomManager.publicPlayer`): `{ username, points, isHost, connected, lastGuess,
  lastAnswerCorrect }` (`connected` is false only for a player disconnected for longer than `DISCONNECT_GRACE`:
  short absences are not shown). Never `socketId`, `rejoinToken`, `plantedPhoto` or `hasPlantedPhoto` (of anyone: whether a
  player planted a photo only goes back to that player, in `room-of-game.hasPlantedPhoto`), nor `isReady` (who is
  ready last could point at a player still uploading). While the round in play
  is in `answering`/`reveal`, `lastGuess: ""`, `lastAnswerCorrect: false` and `points` without the point a correct
  answer earned (shown from `round-scores` on), the same rule as the `game-state` snapshot. A game that ends
  during `answering`/`reveal` (abandoned, pauses used up) drops that unrevealed round's answers and points:
  `game-over.finalScore` and the later snapshots never show them.
- `room-of-game.room` is also an allowlist: `{ gameCode, rounds, started, round, phase, held, paused, players }`
  (no current photo owner: it is secret until `round-reveal`, see "Whose photo it is").

## Disconnected players

- A socket disconnect keeps the player in the room (they can rejoin with the same username and their
  `rejoinToken`) but marks
  them `connected: false`; rejoining marks them `connected: true` again. Whoever has been disconnected for longer than
  **`DISCONNECT_GRACE` (15 s)** is *gone*; shorter absences (switching apps, a brief signal loss) go unnoticed
  (DEC-009). Gone players still in the room when the next game starts are removed (see "Game start drops gone
  players").
- **Lobby** (no game running), when a player has been gone for the grace (`GameEngine.reviewLobby`, also run at
  `game-over` for players who dropped during the game):
  - the room gets **`player-connection { username, connected: false }`**; when they rejoin it gets
    `player-connection { username, connected: true }`. The app shows gone players dimmed with a "disconnected" label.
    Nothing is sent for an absence shorter than the grace.
  - if the gone player is the **host**, the role goes to the first connected player (`new-host`, as on a leave).
    The old host keeps their place and, if they come back, is a normal player. With nobody connected the role stays
    put until someone rejoins. Mid-game the host never changes this way (only by leaving).
  - When the host leaves, the role goes to the first *connected* player (the first player if nobody is connected).
- A client that silently loses network is detected by the socket.io heartbeat within
  `PING_INTERVAL + PING_TIMEOUT` (**10 s + 15 s**, `Server/app.ts`), overridable with
  `SOCKET_PING_INTERVAL_MS` / `SOCKET_PING_TIMEOUT_MS` (clamped to 1 s..300 s).
- Each round's photo owner is picked only among **connected** players.
- When no connected player is left (everyone disconnected, or the last connected one left), the room is
  deleted after **30 min** (`ROOM_CLEANUP_DELAY`), or **2 min** if it never had a second player, unless
  someone successfully rejoins/joins first (rejected joins do not postpone the deletion). A running game in such a
  room pauses and ends when the pause expires (5 min, below), so no game timers outlive it; deleting a room
  clears its timers.
- Photo-wait timeouts and `photo-unavailable` skip the round (`round-skipped`), but after **3 consecutive skips**
  (`MAX_CONSECUTIVE_SKIPS`) the server ends the game (`game-over`) instead of skipping forever.
  Any round that is actually played (uploaded or planted photo) resets the counter. An owner going away (left, or
  disconnected and not back within 3 s, see "Waiting for the photo") hands the round to another player and doesn't
  count while that player has free owner changes left (2 per game); beyond them it counts, and so does the replay of
  a round once everyone went away as its owner.

## Pause and reconnect

Short absences (app in the background, brief signal loss) are silent: socket.io reconnects on a **new** socket,
the client re-sends `join-create-game` with its `rejoinToken`, and the server answers the rejoin with
`room-of-game` followed by a **`game-state` snapshot** to that socket only (always on a rejoin, also in the lobby,
whose screen uses it only to finish loading: after a `room-of-game` with `room.started` it keeps its loading screen
until the `game-state`, which then opens the game screen if `started`, or shows the lobby if not). The snapshot is taken after the rejoin's effect on a pause (resume), so it is never stale. The client keeps the game screen meanwhile and shows a small "Reconnecting…" indicator.

Rejoining from the lobby screen (the app was closed and the player uses "Join" again with their stored
`rejoinToken`): the WaitingRoom gets `room-of-game` + a `game-state` with `started: true`, opens the game screen
and, once the game screen listens, re-sends `join-create-game` on the **same** socket; the server answers with a
fresh snapshot (and `your-turn` for an awaited photo), which the game screen renders like any reconnect. Events
that reached the lobby screen in between are covered by that snapshot.

- **`game-state`** = `{ started, phase, round, totalRounds, photo, correctAnswer, yourGuess, duration, phaseTotal, held,
  pause, scores, players }`, the same for every recipient except `yourGuess`: the recipient's own recorded answer,
  only in `reveal`/`scores` (as in their `round-reveal`; `""` = no guess), else `null`. `duration` is the remaining
  time of the current phase (frozen while paused/held), `phaseTotal` its full duration (see "Phase totals in resync payloads"). `photo` is only set in `answering`/`reveal`/`scores` (the owner's name is never in it before
  the reveal: `correctAnswer` carries it from `reveal` on);
  in `waiting-photo`, `round` is the last played round (the awaited one is `round + 1`, as in `waiting-photo`) and
  `duration` what is left of the photo wait, so the client renders the same waiting screen as for `waiting-photo`;
  `correctAnswer` only in `reveal`/`scores`. `pause` is `{ duration, waitingFor, pause, maxPauses }` (same as `game-paused`) while paused, else `null`.
  `started: false` means the game ended while the player was away (`scores` are the final scores).
  Until `round-scores` (phases `waiting-photo`/`answering`/`reveal`), `scores` and `players` hide this round's
  answers: `lastGuess: ""`, `lastAnswerCorrect: false` and `points` without the point a correct answer earned.
  `scores` is ordered by those shown points, highest first, ties in room order (as `round-scores`), so the order
  can't tell who guessed right (and so whose photo it is) either.
  The client renders that phase; in `answering` it re-sends its current pick of that round, if any (never in
  `reveal`: answers are frozen by then); with `phase: null` (ready phase) it sends `im-ready` again.
- The photo owner who rejoins while their photo is awaited gets `your-turn` again (same `round` and `attempt`);
  the client re-sends the photo it already uploaded for that request instead of uploading a new one. That
  `your-turn` always comes **after** the owner's `game-state` (also when their return resumes the game:
  `game-resumed`, `game-state`, `your-turn`), because the client drops a turn in flight on `game-state`. A new owner
  picked because of that rejoin (it resumes a game whose owner left meanwhile) is announced after the rejoiner's
  `game-state` too (`game-resumed`, `game-state`, `waiting-photo`, `your-turn` to the new owner); the owner who left
  is never asked again.
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
  `game-resumed { phase, duration, phaseTotal }` and the frozen phase continues with its remaining time (at least 1.5 s;
  at least 5 s when waiting for a photo, normal or planted alike, so the countdown never tells them apart; the owner
  gets `your-turn` again). A pause at a round boundary
  resumes by starting that round (new owner, same round number). Scores and round numbers are untouched.
- **Expiry**: when a pause's countdown runs out, `game-over`.
- With 2 or more players connected the game goes on without the missing ones (never picked as photo owner).
- Disconnect detection depends on the socket.io heartbeat (`pingInterval` + `pingTimeout`), unless the client
  closes the socket itself; a player whose loss the server hasn't noticed yet is still "connected", and a
  rejoin before that just rebinds the player to the new socket (the old socket's disconnect is ignored).

### Phase totals in resync payloads

`game-state`, `game-resumed` and `hold-resume` send what is left of the phase (`duration`) and **`phaseTotal`**: the
full duration the phase had when it started, i.e. the `duration` of the event that started it (`waiting-photo`
15 s, `round-start` 7.7 s, `round-reveal` 3 s, `round-scores` 5 s). Pauses, holds and resume minimums never change it,
and it is never less than `duration`. The client draws the progress bar from `1 - duration / phaseTotal`, so a
player who reconnects into a phase it never saw start (it was away when the phase changed) sees the bar where it is
for everyone else, not empty. Before any start event (the ready phase, or a round about to start after a pause at a
round boundary) the countdown is shown whole: `phaseTotal` = `duration`. A game over snapshot sends 0 for both.
As with the start events, the bar ends `duration` after the payload arrived on the device, however late it is painted
(EXP-300).

## Hold (pause)

- Available to the photo owner during the `scores` phase only (with at least 1.5 s of it left); `hold-start` in any
  other phase (`waiting-photo`, `answering`, `reveal`), while paused or already held is ignored. The app shows the
  hold button in `scores` to the player whose username is the round's `correctAnswer` (nobody is told earlier)
- Press: game pauses for everyone (server stops timer)
- Release: game resumes from where it paused
- An owner who goes away while holding (`leave-room`, removed by the host, connection lost) or rejoins on a new
  socket releases the hold at once: `hold-end` + `hold-resume`, as a force-release (a rejoiner gets its `game-state`
  after it, with `held: false`)
- Limits per round: at most **3 holds**, **30 s held in total** (`MAX_HOLDS_PER_ROUND`, `HOLD_BUDGET_PER_ROUND`).
  A hold is force-released (`hold-end` + `hold-resume`) when it reaches what is left of the budget; once the
  budget or the count is used up, `hold-start` is ignored until the next round. A pause ends an active hold and
  charges its time too.
- `hold-start` is also rate-limited per socket (burst 3, refilled 1 every 2 s; excess dropped); `hold-end` is
  ignored from a socket that holds nothing, and only a real release counts against its limit (burst 10, refilled
  1/s, see "Per-socket event limits"); releases never outnumber accepted holds, so a release always gets through

## Events (Server → Client)

All game events are **atomic** — each contains everything the client needs.

| Event | Phase | Data | Description |
|-------|-------|------|-------------|
| `room-of-game` | - | `{ success, room?, message?, rejoinToken?, hasPlantedPhoto? }` | Join result (token and own planted mark only to the joiner) |
| `player-joined` | lobby | public player | A new player joined (not sent for rejoins; not to the joiner) |
| `player-left` | any | `username` (string) | A player left (`leave-room`, a join to another room, or removed as gone at game start) |
| `player-removed` | any | public player | The host removed this player (`remove-player`) |
| `rounds-updated` | lobby | `rounds` (number) | The host changed the number of rounds |
| `game-started` | - | `players, rounds` | Navigate to game screen (public player data only, see "Public player data") |
| `waiting-photo` | waiting-photo | `{ round, duration }` | Whole room: a photo is awaited (owner not revealed), show wait bar |
| `your-turn` | waiting-photo | `{ round, attempt }` | Only the picked player: pick and upload a photo (or send `photo-unavailable`) |
| `round-start` | answering | `{ photo, round, duration }` | Show photo, start answer timer (`duration` = 7.7 s: 300 ms grace before answers freeze). Same payload for the whole room, owner included (never tells whose photo it is) |
| `round-reveal` | reveal | `{ correctAnswer, duration, yourGuess }` | Show correct answer. One per player: `yourGuess` is the recipient's own recorded answer (`""` = none), which the app colours |
| `round-scores` | scores | `{ scores, round, totalRounds, duration }` | Show scoreboard (`scores`: `{ username, points, isHost, lastAnswerCorrect, lastGuess }[]`, highest first, ties in room order) |
| `hold-start` | scores | - | Pause everything visually |
| `hold-end` | scores | - | The hold is over (released, force-released or ended by a pause); `hold-resume` carries the time |
| `hold-resume` | scores | `{ phase, duration, phaseTotal }` | Resume with remaining time (`phaseTotal`: the phase's full duration) |
| `round-skipped` | - | `{ round, reason: "timeout" \| "unavailable" }` | No photo for this round; the next `waiting-photo` follows |
| `game-paused` | any | `{ duration, waitingFor, pause, maxPauses }` | Fewer than 2 connected: freeze, show countdown and "pause N of M" |
| `game-resumed` | any | `{ phase, duration, phaseTotal }` | Paused phase continues with remaining time (`phaseTotal`: the phase's full duration) |
| `game-state` | any | snapshot (see "Pause and reconnect") | Only to a rejoining socket (or one re-sending its join in a started game): render current phase |
| `game-over` | - | `{ finalScore }` | Show final results (`finalScore`: same shape as `round-scores.scores`) |
| `player-connection` | lobby | `{ username, connected }` | A player is gone (disconnected > 15 s) or back: dim / undim them in the lobby list |
| `new-host` | any | public player | The host left (lobby or mid-game), was removed at game start, or has been gone > 15 s in the lobby (also checked at game-over): this player is the host now |
| `chat-message` | any | `{ username, message }` | Chat from another player (not echoed to the sender) |
| `emoji-reaction` | any | `{ username, emoji }` | Emoji reaction, to the whole room (sender included) |

## Events (Client → Server)

| Event | Data | Description |
|-------|------|-------------|
| `join-create-game` | `{ gameCode \| null, username, rejoinToken? }` | Create/join; rejoin needs `rejoinToken` (also after every reconnect in game) |
| `set-rounds` | `{ rounds }` (10/15/20; 3 only with `ALLOW_QA_ROUNDS=1`, QA-only) | Host only, lobby only |
| `start-game` | - | Host only |
| `remove-player` | `{ username }` | Host only: removes that player (not the host) and evicts their sockets |
| `leave-room` | - (with an ack callback) | Explicit leave (Exit button): player removed, host handed over, `player-left` to the room; from a socket replaced by a rejoin it only detaches that socket. Acked (no data) once handled, also from a socket bound to no room; not acked when dropped by the rate limit |
| `im-ready` | - | Player ready to start (session player; payload ignored) |
| `photo-sent` | `{ photo }` | Photo uploaded; only from the current owner, `photo` must be a path the owner got from `/upload` in this room (`/temp/<32 hex>.jpg\|png\|webp`) for the photo awaited now (uploaded during this `waiting-photo`'s round as their turn photo; not a planted photo, not one from an earlier round) |
| `photo-unavailable` | `{ round, attempt }` (from its `your-turn`) | The awaited owner has no photo to send (no access, no photos, upload failed): skip the round now |
| `submit-answer` | `{ guess }` | Player's pick, sent on every tap (the photo owner's too, scored like any other). Only during `answering`, the last one counts (`""` withdraws it); ignored in `reveal`/`scores`, or if `guess` is not a player in the room; at most 10 per socket, refilled 5/s (excess dropped). No guess is stored and sent in scores as `lastGuess: ""` (the app shows its own translated "No guess") |
| `hold-start` | - | Photo owner pressed hold (scores only; per-round limits, see "Hold") |
| `hold-end` | - | Photo owner released hold |
| `chat-message` | `{ message }` (≤100 chars) | Broadcast as `{ username, message }` with the session username |
| `emoji-reaction` | `{ emoji }`, exactly one of 😂 😍 ❓ 😳 🔥 😭 🤡 😡 (the app's picker) or 📸 (the app sends it when a screenshot is taken) | Broadcast as `{ username, emoji }` with the session username. Anything else is dropped; at most 5 per socket, refilled 4/s (excess dropped silently) |
| `plant-photo` | `{ photoUrl }` (with an ack callback) | Applies to the session player (replaces their earlier one); `photoUrl` must be the player's own `/upload` path in this room; accepted until the first round is played. Acked `{ ok: true }` or `{ ok: false, reason: "not-in-room" \| "invalid" \| "too-late" \| "photo-unavailable" }` (see "Planting"); not acked when dropped by the rate limit |
| `qa-ack` | `{ phase, round, at, handledAt? }` (`phase` one of the four round phases, `round` integer, `at` device clock in ms when the phase was painted, optional `handledAt` device clock in ms when the socket handler of the event that started it ran) | **Dev/QA only**, handled only when the server runs with `QA_TELEMETRY=1` (see "QA render telemetry"); otherwise not even registered |

Payload `gameCode`/`username` fields are ignored for all of the above; identity comes from the session.

## Per-socket event limits

Every client event is rate-limited per socket (the limits live and die with the socket); events over a limit are
dropped silently: no answer and no broadcast (a dropped `set-rounds` sends no `rounds-updated`, so the host's
optimistic pick would not be corrected; its limit is far beyond any human tapping). They sit well above what the
app or the bots send, and only cap the work a flood can cause (each handler also ignores events that don't apply).
Token buckets: burst, then refilled at the rate.

| Event | Limit |
|-------|-------|
| `join-create-game` | 5 in any 10 s (excess answered "Too many attempts", see "Join, rejoin and session") |
| `leave-room` | burst 5, refilled 1 every 2 s |
| `set-rounds` | burst 30, refilled 10/s |
| `start-game` | burst 5, refilled 1/s |
| `remove-player` | burst 12 (a full room), refilled 2/s |
| `im-ready` | burst 5, refilled 1/s |
| `photo-sent` | burst 20, refilled 2/s |
| `photo-unavailable` | burst 5, refilled 1/s |
| `submit-answer` | burst 10, refilled 5/s |
| `hold-start` | burst 3, refilled 1 every 2 s |
| `hold-end` | burst 10, refilled 1/s; only real releases (from the socket holding) count, the rest is ignored |
| `chat-message` | one every 250 ms |
| `emoji-reaction` | burst 5, refilled 4/s |
| `plant-photo` | burst 5, refilled 1 every 2 s |
| `qa-ack` | burst 10, refilled 2/s (dev/QA only) |

The game-event limits are `GAME_EVENT_LIMITS` in `managers/socketGuards.ts`.

## QA render telemetry (dev only)

Bot metrics only show when the server *sent* a phase; this shows when each phone actually *rendered* it.

- QA builds of the app (development bundles from a Metro started with `EXPO_PUBLIC_QA=1`, as `qa/lab/lab.sh metro`
  does; a release bundle never sends it) send
  **`qa-ack { phase, round, at, handledAt? }`** right after the game screen commits a new phase (once per phase start:
  every `waiting-photo`, `round-start`, `round-reveal`, `round-scores`, and a resumed/rejoined phase). `handledAt` is
  the device time the socket handler of that `waiting-photo` / `round-start` / `round-reveal` / `round-scores` started
  (absent for a phase started by a resume, rejoin or hold). Regular builds never send it.
- The server handles it only with **`QA_TELEMETRY=1`** (`qa/lab/lab.sh server` sets it; production never does, so the
  event is ignored there). Accepted only from a session player, with a valid payload, at most 10 per socket refilled
  2/s; it appends one JSON line `{ gameCode, username, phase, round, at, handledAt?, receivedAt, serverAt? }`
  (`receivedAt`: server clock on receipt; `serverAt`: server clock when that phase of that round was broadcast,
  if it was broadcast only once in that round; kept for the current and the previous round, so an ack that arrives
  after the next phase's broadcast still gets it) to `QA_TELEMETRY_FILE` (written synchronously, so lines keep arrival order), or logs
  it when no file is set. Nothing is ever sent back. Each lab server start moves the previous file to `<file>.prev`.
- After `lab.sh play`, the lab prints the per-phase device render skew (spread of `receivedAt` across devices for the
  same round and phase: p50/p95/max) next to the bots summary, and per device and phase (`latency`) the delivery delay
  (`serverAt` → `handledAt`, the device clock corrected by its offset to the server's, estimated NTP-style from its ack
  with the shortest round trip) and the handler → paint cost (`at − handledAt`), p50/p95.

## Photo upload (HTTP)

`POST /upload` (multipart, one file in field `image`, ≤5MB) → `200 { url: "/temp/<32 random hex>.<jpg|png|webp>" }`.
The app sends JPEGs of at most 1600 px (~300–600 KB), far below the limit.

**Room members only.** Both `POST /upload` and `GET/HEAD /temp/<photo>` need the player's session credential from
`room-of-game`, as headers: `X-Game-Code: <room code>` and `Authorization: Bearer <rejoinToken>` (the token never
goes in a URL; the app passes the same headers to `<Image source={{ uri, headers }}>`). Missing or malformed → **401**,
unknown room or a token that is not a current member of it → **403**.

- Every upload is bound to the room and player that sent it. It is accepted from any member until the first round
  has actually been played (planted photos: lobby, ready phase, or `waiting-photo` while `room.round` is still 0,
  also after skips; the app uploads it from the lobby; `plant-photo` follows exactly the same rule), and after
  that only from the player whose photo the server is awaiting (`waiting-photo` and they are the picked owner, paused
  or not); otherwise **403**. Each upload is a *turn* upload (sent while the server awaits this player's photo) or a
  *planted* one (anything else: lobby, ready phase, round 1 not yet played). Each player holds at most **two unused
  uploads per round and kind**: a new upload deletes the same player's older uploads of the same round (`room.round`
  when stored) and kind that were neither planted nor shown, keeping the newest earlier one (it may still be about
  to be planted/sent: the app can run its planted-photo retry and its round-1 upload at once). A turn upload thus
  never drops a lobby pick. A new `plant-photo` deletes the planted photo it replaces; planted and played photos stay
  until `game-over` (unless their uploader leaves, see Deletion). A *planted* upload that no `plant-photo` claims
  within `UPLOAD_PLANT_CLAIM_MS` (default 2 min; the app sends it as soon as the upload answers) is deleted then, e.g.
  a turn upload retried after background that only arrives once the game is over, back in the lobby. A `plant-photo`
  sent after that is ignored like any other path that is no longer stored (the player then has no planted photo, as
  `room-of-game`'s `hasPlantedPhoto` tells them). So one member can't fill the room (re-picking in the lobby, retries
  on their turn). At most 100 stored photos per room (**429** beyond, a backstop). If the game ends, the room closes
  or the player leaves while the image is being processed, nothing is stored (**409**).
- `GET /temp/<photo>` serves the photo only to members of the room it was uploaded in (`Cache-Control: no-store,
  private`); a photo of another room, a deleted/expired one or any other path under `/temp` → **404**. A player who
  left or was removed is no longer a member (403).
- **Deletion**: all of a room's photos (played and planted) are deleted at `game-over`, when its last player leaves,
  and when the room is deleted. A player's own photos are deleted when they leave or are removed, except the photo
  on screen this round, deleted once that round is over (next photo wait). The 30-min TTL stays as a backstop
  (`UPLOAD_TTL_MS`, by file mtime: a sweep at startup and every 5 min deletes expired uploads and schedules exact
  deletion for those expiring before the next sweep, so restarts don't leave photos behind). The sweep only deletes
  regular files directly in the upload dir named like an upload (`<32 hex>.jpg|png|webp`) or a legacy upload
  (`<13-digit epoch ms>-<name>.jpg|jpeg|png|webp`); symlinks, subdirectories, dotfiles (`.gitkeep`) and any other name
  are never touched.
- `photo-sent` / `plant-photo` take the returned `/temp/...` path, and only a photo that **the sender uploaded in
  this room** (and that still exists); anything else (another player's or another room's photo, a path never
  uploaded) is ignored. `photo-sent` additionally takes only the owner's turn upload for the photo awaited now: an
  upload made while it wasn't their turn (lobby pick, planted photo), one marked with `plant-photo`, or one stored in
  an earlier round (already shown) is ignored.
- Accepted formats: JPEG, PNG, WebP, detected from the file contents (the file name and declared MIME type are ignored). The app is expected to send JPEG; HEIC and anything else is refused.
- The stored image is re-encoded: orientation applied, scaled down to fit 2048×2048, all metadata (EXIF incl. GPS, XMP, ICC) removed, same format as the input.
- Images are processed one at a time (`controllers/sanitizeImage.ts`). The queue holds `UPLOAD_INFLIGHT_MAX` jobs, so an upload admitted by the in-flight caps is never refused for a full queue; a queued job is dropped if its client disconnects, and `SANITIZE_QUEUE_TIMEOUT_MS` (60 s) is only a safety net for a stuck job. Waiting jobs take turns by uploader IP (round-robin, each IP's own jobs in arrival order), so an upload waits for at most one job of each other IP with uploads queued, however many that IP sent.
- **Server-wide storage limits** (on top of the 100 per room; `middlewares/uploadStore.ts`): they only apply to **lobby photos**, i.e. every upload except the awaited owner's turn photo (lobby picks and planted photos, also in the ready phase). A lobby photo is refused while the server stores `UPLOAD_STORED_MAX` photos (default 3000, all rooms and kinds together) → **503** `{ error: "Server busy", scope: "storage" }`, or when its uploader's IP already has `UPLOAD_LOBBY_PER_IP_MAX` lobby photos stored (default 150, across all rooms; IPv6 counted per /48; each player holds ~3, so a full party of 12 needs ~36 and several parties fit on one venue Wi-Fi) → **429** `{ error: "Too many photos stored", scope: "lobby-ip" }`, so one IP can't fill the server-wide budget from rooms of its own. Both are checked before processing and again right before storing; `Retry-After` is the time until the first photo counted by that limit goes: its TTL expiry, or its claim deadline (`UPLOAD_PLANT_CLAIM_MS`) while it is a planted upload nobody has planted (photos are usually released sooner, at game over). The turn photo of a started game is **never** refused by these limits (one per round, at game pace, still bounded by the room cap).
- **Order of checks** (nothing reads the body before multer): a `Content-Length` over the limit → **413** at once (no
  slot taken); then the credentials (401/403); then the member takes an **in-flight slot**; then the per-minute rate
  limits; then the room's acceptance (403) and the body. In-flight caps limit how many uploads are in progress (being
  received or processed) *at once* (concurrency, not rate; `middlewares/uploadInFlight.ts`): per member (env `UPLOAD_INFLIGHT_PER_MEMBER_MAX`,
  default 2), per room (`UPLOAD_INFLIGHT_PER_ROOM_MAX`, 12) and per IP (`UPLOAD_INFLIGHT_PER_IP_MAX`, 12; a full party shares one IP) → **429**, and
  server-wide (`UPLOAD_INFLIGHT_MAX`, 32) → **503**. Once half the server-wide slots are taken, an IP only gets a new
  slot while it holds fewer than `UPLOAD_INFLIGHT_PER_IP_BUSY_MAX` (default 4) → **429** `scope: "ip"`, so a few IPs
  can't take every slot (filling them needs 6 IPs by default) and a party gets its full 12 back as the server drains. The refusal carries `Retry-After` and
  `{ error, scope: "member" | "room" | "ip" | "server" }`. An admitted upload must be fully received within
  `UPLOAD_REQUEST_TIMEOUT_MS` (default 20 s) → **408** and the connection is closed (only reception is timed: a complete
  body that waits for processing is not cut); the slot is freed with the response, or if the client aborts. `qa/lab/lab.sh server` raises the in-flight caps for bot load tests (all bots share one IP).
- **HTTP timeouts** (all routes): the whole request must arrive within `HTTP_REQUEST_TIMEOUT_MS` (default 60 s) and its
  headers within `HTTP_HEADERS_TIMEOUT_MS` (default 20 s); WebSocket connections are not affected.
- Errors are JSON `{ error }`:

| Status | When |
|--------|------|
| 401 | Missing/malformed `X-Game-Code` or `Authorization: Bearer` header |
| 403 | Not a member of that room, or the room isn't accepting a photo from this player now |
| 409 | The game ended / room closed / player left while the upload was processed (nothing stored) |
| 400 | No file, malformed multipart, more than one file, wrong field, undecodable image |
| 408 | Upload not fully received within `UPLOAD_REQUEST_TIMEOUT_MS` (20 s) |
| 413 | File over 5MB (refused before reading the body when `Content-Length` already says so), or image over 24 megapixels |
| 415 | Not JPEG/PNG/WebP (e.g. HEIC) |
| 429 | Room already holds 100 photos, a lobby photo from an IP that already has `UPLOAD_LOBBY_PER_IP_MAX` lobby photos stored (150, `scope: "lobby-ip"`, see the storage limits above), or rate limit (`Retry-After`). Credentials are checked first: only **rejected** requests (the 401/403 above) count per IP, default 30/min (env `UPLOAD_REJECTED_MAX`), and once over it that IP's missing/malformed credentials get 429 instead of 401 (well-formed but wrong or expired ones always get 403, so a client re-authenticates instead of waiting). Members are never rate-limited per minute by IP (a party shares one public IP); only concurrent uploads per IP are capped (12, or 4 once the server is half full, below). Per minute: per member, default 20/min (env `UPLOAD_PLAYER_RATE_MAX`; counted per seat, so someone joining under a departed player's name starts afresh), and per room, default 12 × the member limit (env `UPLOAD_ROOM_RATE_MAX`; only counted once the game has started, since in the lobby one person could leave and rejoin under new names to use it up), so neither a stranger on the Wi-Fi nor a member over their own limit can make another member's upload fail. Same window for all, env `UPLOAD_RATE_WINDOW_MS` (60 s); `qa/lab/lab.sh server` raises the member and room limits for bot load tests. Also too many uploads **in progress at once** (concurrency, not rate) for this member (2), room (12) or IP (12), with `scope` `member`/`room`/`ip` (see the order of checks above). Every per-IP count here uses the same key as the socket limits (IPv4-mapped IPv6 as IPv4, IPv6 by its /64) |
| 503 | Server busy: too many uploads in progress server-wide (32, `scope: "server"`), a lobby photo while the server already stores `UPLOAD_STORED_MAX` photos (3000, `scope: "storage"`), or an image stuck in processing longer than `SANITIZE_QUEUE_TIMEOUT_MS` (`Retry-After`) |

Behind a reverse proxy, env `TRUST_PROXY` is the number of proxy hops used to read the client IP (default 1 when `RENDER` is set, otherwise 0). Env `UPLOAD_DIR` overrides the storage directory (default `Server/temp`); it must be a dedicated directory: if it is the OS temp dir, the filesystem root or the home directory the sweep refuses to run (one warning in the log).

`GET /health` → `200 { "status": "ok" }` (liveness only: no uptime, memory or other process details).

Any other HTTP route answers **404** JSON `{ "error": "Not found" }` (the path is never echoed), and other errors
are handled by the final JSON error handler (`{ error }`, a 4xx only for integer 400–499 statuses, otherwise 500).
Every response carries security headers: `Content-Security-Policy: default-src 'none'; frame-ancestors 'none';
base-uri 'none'; form-action 'none'`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-site` (browsers only; React Native image loads
are unaffected), `Strict-Transport-Security: max-age=15552000`, and no `X-Powered-By`. The `/join/<code>` invite page
(the link the app shares) accepts a code in any case, normalizes it like a join (trim, uppercase) and answers **400**
`Invalid game code` when it is malformed; a valid one gets a page that opens
`exposeme://screens/WaitingRoom?code=<CODE>` (canonical uppercase code; the app normalizes the `code` parameter again
and ignores a malformed one). It overrides the CSP to allow its inline style and only its inline script, by a per-response nonce.
