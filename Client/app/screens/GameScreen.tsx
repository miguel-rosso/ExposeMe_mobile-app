import React, { useEffect, useState, useCallback, useRef } from "react";
import { View, Text, TouchableOpacity, StatusBar, FlatList, BackHandler, useWindowDimensions } from "react-native";
import { useFocusEffect } from "expo-router";
import tw from "twrnc";
import { useGameContext } from "../providers/GameContext";
import {
  GamePausedData, GameResumedData, GameStateSnapshot, HoldResumeData, Player, RoundRevealData,
  RoundScoresData, RoundSkippedData, RoundStartData, ScoreRound, WaitingPhotoData, YourTurnData,
} from "../models/interfaces";
import { usePhotoContext } from "../providers/PhotoContext";
import { useRouter } from "expo-router";
import getEnvVars from "@/config";
import PhotoComponent from "@/app/components/PhotoComponent";
import ScoreModal from "@/app/components/modals/ScoreModal";
import { TEST_IDS, playerOptionId } from "@/app/utils/testIds";
import ProgressBar from "@/app/components/ProgressBar";
import FinalScoreModal from "@/app/components/modals/FinalScoreModal";
import WinnerModal from "@/app/components/modals/WinnerModal";
import { getWinners } from "@/app/utils/ranking";
import EmojiReactionLane, { EmojiReactionData } from "@/app/components/IngameComunication/EmojiReactionLane";
import EmojisButton from "@/app/components/IngameComunication/EmojisButtons";
import { useI18n } from "../i18n";
import { uploadPhoto } from "@/app/utils/uploadPhoto";
import { photoAuthHeaders, resolvePhotoAuth } from "@/app/utils/photoAuth";
import { uploadWithRetry } from "../utils/uploadRetry";
import { SkipNotice, skipNoticeFor, skipNoticeText } from "../utils/waitingPhoto";
import { gameStateFollowUps, initialRoundView, isRevealedOwner, RoundAction, roundReducer, RoundView } from "../utils/roundState";
import { useGameConnection } from "../hooks/useGameConnection";
import { useTurnRequest } from "../hooks/useTurnRequest";
import { withHost, withoutPlayer } from "../utils/roomPlayers";
import PausedModal from "@/app/components/modals/PausedModal";
import GalleryAccessModal from "@/app/components/modals/GalleryAccessModal";
import { useGalleryAccessGuard } from "@/app/hooks/useGalleryAccessGuard";
import { useQaRenderAck } from "../hooks/useQaRenderAck";
import { useScreenshotReaction } from "../hooks/useScreenshotReaction";
import { appendCapped, isAllowedReaction, MAX_VISIBLE_REACTIONS } from "../utils/reactions";
import { answerOptionsLayout } from "../utils/answerOptionsLayout";
import { attachHandlers, SocketHandlers } from "../utils/socketHandlers";

const { SERVER_URL } = getEnvVars();
const PICK_SEND_INTERVAL = 200; // ms between submit-answer sends (server: 10 per socket, refilled 5/s)
// Round progress bar strip at the top of the photo (bar plus its padding); emoji reactions start right below it
const PROGRESS_BAR_AREA = { top: 60, height: 40 } as const;
const REACTION_LANE_TOP = PROGRESS_BAR_AREA.top + PROGRESS_BAR_AREA.height;
// Answer option cards: compact ones keep a 44 dp touch target (py-3 + a text-sm line) for crowded rooms. Their names
// are cut in the middle: the end stays, so names sharing a long prefix ("Maria_01" / "Maria_02") still differ
const OPTION_CARD = {
  regular: { card: "p-3 mb-2", text: "text-base", ellipsize: "tail" },
  compact: { card: "py-3 px-2 mb-1.5", text: "text-sm", ellipsize: "middle" },
} as const;
const OPTION_BASIS = { 2: "flex-basis-[48%]", 3: "flex-basis-[30%]" } as const;

const GameScreen = () => {
  const { t } = useI18n();
  const {
    username, gameCode, socket, playersProvider, setPlayersProvider, roundsOfGame, plantedPhotoUri,
    plantedPhotoSent, plantPhoto, getRejoinToken, saveRejoinToken, setPlantedPhotoUri,
  } = useGameContext();
  const safeUsername = username ?? "";
  const safeGameCode = gameCode ?? "";
  const { pickGamePhoto, setPhotoUri, resetUsedPhotos } = usePhotoContext();
  // One game screen per game (reconnects stay on it): a new screen is a new game, earlier photos may come up again.
  // Optional call: screen tests mock the photo context with only what their flow needs.
  useEffect(() => { resetUsedPhotos?.(); }, [resetUsedPhotos]);
  const router = useRouter();
  // Photo access revoked / no photos left (re-checked on foreground): blocking overlay, the game screen stays
  const galleryGuard = useGalleryAccessGuard({ watch: true });
  // One screenshot listener for the whole game (EmojisButton remounts every round)
  useScreenshotReaction(socket);

  // ── Round state (reset each round) ───────────────────
  // roundRef always holds the latest state, updated on dispatch: socket listeners and timers read it (their closures
  // would see stale state), and back-to-back events build on each other. The screen renders roundView.
  const roundRef = useRef<RoundView>(initialRoundView);
  const [roundView, setRoundView] = useState<RoundView>(initialRoundView);
  const dispatchRound = (action: RoundAction) => {
    roundRef.current = roundReducer(roundRef.current, action);
    setRoundView(roundRef.current);
  };
  const {
    photo, round, phase, phaseDuration, phaseKey, correctAnswer, scores, mySelection, gameHeld, pressing,
  } = roundView;
  // QA builds only: tells the server when this device rendered each phase (lab render-skew metrics); the phase
  // handlers below call markPhaseHandled first, so the ack also says when their event arrived
  const markPhaseHandled = useQaRenderAck(socket, phase, round, phaseKey);
  // My pick goes to the server as soon as it changes: answers are only taken while answering (EXP-148), the last counts.
  // Rapid taps are coalesced: at most one send per PICK_SEND_INTERVAL, then a trailing send of the latest pick, so the
  // server's per-socket rate limit never drops the pick that counts. When the answer bar ends, a pick still waiting
  // goes at once (within the server's 300 ms grace) and later taps are ignored.
  // Only a pick emitted while connected is recorded as sent (one made offline is lost: the rejoin drops it).
  const lastPickSentAt = useRef(0);
  const pickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendPick = () => {
    if (pickTimer.current) clearTimeout(pickTimer.current);
    pickTimer.current = null;
    lastPickSentAt.current = Date.now();
    const guess = roundRef.current.mySelection;
    socket?.emit("submit-answer", { guess });
    if (socket?.connected) dispatchRound({ type: "pick-sent", guess });
  };
  const pickGuess = (val: string) => {
    dispatchRound({ type: "pick", guess: val });
    if (pickTimer.current) return; // the pending trailing send takes the latest pick
    const wait = lastPickSentAt.current + PICK_SEND_INTERVAL - Date.now();
    if (wait <= 0) { sendPick(); return; }
    const pickRound = roundRef.current.round;
    pickTimer.current = setTimeout(() => {
      // Answering is over meanwhile (reveal, or a new round / photo wait): too late, that pick can't count
      if (roundRef.current.round === pickRound && roundRef.current.phase === "answering") sendPick();
      else pickTimer.current = null;
    }, wait);
  };
  useEffect(() => () => { if (pickTimer.current) clearTimeout(pickTimer.current); }, []);
  // The answer bar (server duration) has run out: no more picks this phase (phaseKey changes with every phase/resume)
  const [answersClosedKey, setAnswersClosedKey] = useState(-1);
  const answersClosed = phase === "answering" && answersClosedKey === phaseKey;
  const closeAnswers = () => {
    if (pickTimer.current) sendPick(); // flush the pick waiting for its throttle slot: it must leave before the close
    setAnswersClosedKey(phaseKey);
  };
  // Latest players list for the room-membership handlers; updated on write too, so back-to-back events
  // (new-host + player-left arrive together) build on each other
  const playersRef = useRef<Player[]>(playersProvider);
  playersRef.current = playersProvider;
  const setPlayers = (next: Player[]) => { playersRef.current = next; setPlayersProvider(next); };

  // ── Waiting for the photo ────────────────────────────
  // My own photo request (your-turn): ended by every TURN_ENDING_EVENTS handler below
  const turnRequest = useTurnRequest(socket);
  const [skipNotice, setSkipNotice] = useState<SkipNotice | null>(null); // last skipped round, until round-start

  // ── Pause (fewer than 2 players connected) ───────────
  const [pauseEndsAt, setPauseEndsAt] = useState<number | null>(null);
  const [pauseCount, setPauseCount] = useState({ pause: 0, maxPauses: 0 });
  const setPause = (p: GamePausedData | null) => {
    setPauseEndsAt(p === null ? null : Date.now() + p.duration);
    if (p) setPauseCount({ pause: p.pause, maxPauses: p.maxPauses });
  };

  // ── End game ─────────────────────────────────────────
  const [finalScore, setFinalScore] = useState<ScoreRound[] | null>(null);
  const [showFinalScore, setShowFinalScore] = useState(false);
  const [showWinner, setShowWinner] = useState(false);
  const [winners, setWinners] = useState<ScoreRound[]>([]);
  const gameOverRef = useRef(false);

  // ── Other ────────────────────────────────────────────
  const [emojiReactions, setEmojiReactions] = useState<EmojiReactionData[]>([]);
  const [isReady, setIsReady] = useState(false);

  // ── Derived ──────────────────────────────────────────
  // Hold button: the photo owner's, during scores only (every event that ends scores also clears the press). Like
  // everyone, the owner only learns the photo was theirs from the reveal (EXP-252)
  const holdButtonMounted = phase === "scores" && isRevealedOwner(correctAnswer, safeUsername);
  // The scoreboard covers the photo in scores: the answer options are not drawn under it
  const showAnswers = phase !== "scores";

  // ── Photo access (room members only: room code + rejoin token) ─
  const uploadImage = async (uri: string): Promise<string> =>
    uploadPhoto(SERVER_URL, uri, await resolvePhotoAuth(getRejoinToken, gameCode, username));
  const [photoHeaders, setPhotoHeaders] = useState<Record<string, string> | undefined>(undefined);
  useEffect(() => {
    let live = true;
    resolvePhotoAuth(getRejoinToken, gameCode, username)
      .then((auth) => { if (live) setPhotoHeaders(photoAuthHeaders(auth)); })
      .catch(() => console.warn("[GAME] no session token: room photos can't be loaded"));
    return () => { live = false; };
  }, [gameCode, username]);

  // ── Block back button ────────────────────────────────
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => sub.remove();
  }, []));

  // ── Hold handlers ────────────────────────────────────
  const onHoldPress = () => {
    if (!holdButtonMounted || !socket || pressing) return;
    dispatchRound({ type: "pressing", pressing: true });
    socket.emit("hold-start");
  };

  const onHoldRelease = () => {
    if (!pressing || !socket) return;
    dispatchRound({ type: "pressing", pressing: false });
    socket.emit("hold-end");
  };

  // ── Connection: stay in the game, rejoin on reconnect ─
  const { connected } = useGameConnection({
    socket, gameCode, username, getRejoinToken, saveRejoinToken,
    onLeave: (message) => {
      console.log("[GAME] Can't rejoin the game — returning to menu");
      router.replace(message ? { pathname: "/", params: { message } } : "/");
    },
  });

  // Removers of this screen's own socket listeners (never socket.off(event): the socket is shared, see socketHandlers).
  // The game ones go at game over, the final screens' ones (attached then) on unmount.
  const detachGameHandlers = useRef<(() => void) | null>(null);
  const detachFinalScreenHandlers = useRef<(() => void) | null>(null);

  const showGameOver = (finalScore: ScoreRound[]) => {
    if (gameOverRef.current) return;
    gameOverRef.current = true;
    detachGameHandlers.current?.();
    // Still in the room on the final screens: when the host starts the next game, join it at once (DEC-018 A), the
    // same way "Play again" does: the lobby rejoins on this socket, gets the started game's snapshot and opens a fresh
    // game screen, which sends im-ready. A snapshot of a started game (I reconnected meanwhile) means the same thing.
    let joiningNext = false;
    const joinNextGame = () => {
      if (joiningNext) return;
      joiningNext = true;
      console.log("[GAME] next game started from the final screens — joining it");
      setPlantedPhotoUri(null); // planted for the game that ended
      router.replace("/screens/WaitingRoom");
    };
    if (socket) {
      detachFinalScreenHandlers.current = attachHandlers(socket, {
        "game-started": joinNextGame,
        "game-state": (snap: GameStateSnapshot) => { if (snap?.started) joinNextGame(); },
        // Until then, if the next game picks me, say at once there is no photo so nobody waits the 15 s photo timeout
        // (the photo is never picked from here)
        "your-turn": (turn: YourTurnData) => {
          socket.emit("photo-unavailable", { round: turn?.round, attempt: turn?.attempt });
        },
      });
    }
    setPauseEndsAt(null);
    setFinalScore(finalScore);
    if (finalScore?.length > 0) { setWinners(getWinners(finalScore)); setShowWinner(true); }
  };

  // ── Socket listeners ─────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    // Game events, detached at game over: the socket stays open on the final screens (still in the room), and a next
    // game started meanwhile must not drive this finished one (e.g. a your-turn picking and uploading a photo behind
    // the modal)
    const gameHandlers: SocketHandlers = {
      // Whole room: a photo is awaited (the owner is not revealed). Comes right before my own your-turn.
      "waiting-photo": (data: WaitingPhotoData) => {
        markPhaseHandled("waiting-photo");
        console.log(`[GAME] waiting-photo: round ${data.round}, ${data.duration}ms`);
        // Any earlier request of mine is over; a report of mine was answered by the round-skipped before this
        turnRequest.endTurn({ forgetReport: true });
        dispatchRound({ type: "waiting-photo", data });
      },

      // My turn: pick photo → upload → send (or report photo-unavailable), all in the background: nothing on screen
      // changes, so I can't tell the next photo is mine and guess like everyone (EXP-252)
      "your-turn": async (data: YourTurnData) => {
        const needsUpload = turnRequest.start(data); // a re-sent request re-sends or awaits its photo
        dispatchRound({ type: "your-turn", round: data.round });
        if (!needsUpload) return;
        try {
          const picked = await pickGamePhoto();
          if ("error" in picked) { turnRequest.reportUnavailable(picked.error, data); return; }
          let url: string;
          try { url = await uploadWithRetry(picked.uri, uploadImage); }
          catch { turnRequest.reportUnavailable("upload", data); return; }
          setPhotoUri(null);
          turnRequest.sendPhoto(data, url);
          return;
        } catch (e) { console.log("your-turn error:", e); } // never a device toast: my turn must not show (EXP-252)
        turnRequest.reportUnavailable("failed", data);
      },

      // Atomic: new round — photo + answer timer
      "round-start": (data: RoundStartData) => {
        markPhaseHandled("answering");
        console.log(`[GAME] round-start: round=${data.round}`);
        turnRequest.endTurn();
        setSkipNotice(null);
        dispatchRound({ type: "round-start", data, serverUrl: SERVER_URL });
      },

      // Atomic: answer revealed (the server froze answers before this: only a pick already sent can have counted)
      "round-reveal": (data: RoundRevealData) => {
        markPhaseHandled("reveal");
        console.log(`[GAME] round-reveal: ${data.correctAnswer}, my guess: ${roundRef.current.sentGuess}`);
        dispatchRound({ type: "round-reveal", data });
      },

      // Atomic: scores displayed
      "round-scores": (data: RoundScoresData) => {
        markPhaseHandled("scores");
        console.log(`[GAME] round-scores: round ${data.round}/${data.totalRounds}`);
        dispatchRound({ type: "round-scores", data });
      },

      // Hold: everyone pauses
      "hold-start": () => {
        console.log("[GAME] hold-start");
        dispatchRound({ type: "hold-start" });
      },

      // Hold ended (from server force-release or another client)
      "hold-end": () => {
        console.log("[GAME] hold-end");
        dispatchRound({ type: "hold-end" });
      },

      // Hold resume: phase continues with remaining time
      "hold-resume": (data: HoldResumeData) => {
        console.log(`[GAME] hold-resume: ${data.phase} ${data.duration}ms`);
        dispatchRound({ type: "hold-resume", data });
      },

      // No photo for this round: say why on the waiting screen until the next round starts
      "round-skipped": (data: RoundSkippedData) => {
        console.log(`[GAME] round-skipped: round ${data.round} (${data.reason})`);
        setSkipNotice(skipNoticeFor(data, turnRequest.takeReportedReason()));
        turnRequest.endTurn();
      },

      // Fewer than 2 players connected: the server froze the game and shows its countdown
      "game-paused": (data: GamePausedData) => {
        console.log(`[GAME] game-paused ${data.pause}/${data.maxPauses}: ${data.duration}ms, waiting for ${data.waitingFor.join(", ")}`);
        setPause(data);
        dispatchRound({ type: "game-paused" });
        // The server ignores photos while paused and sends your-turn again on resume (an upload that finishes
        // meanwhile is kept and re-sent then)
        turnRequest.endTurn();
      },

      "game-resumed": (data: GameResumedData) => {
        console.log(`[GAME] game-resumed: ${data.phase} ${data.duration}ms`);
        setPauseEndsAt(null);
        dispatchRound({ type: "game-resumed", data });
      },

      // Snapshot after a rejoin: render whatever phase the server is in
      "game-state": (snap: GameStateSnapshot) => {
        console.log(`[GAME] game-state: ${snap.phase} round ${snap.round}, paused=${!!snap.pause}`);
        setPlayers(snap.players);
        // An awaited photo of mine is asked again with your-turn right after this snapshot. A report of mine was
        // answered while I was away (that round-skipped is lost): a later skip is not mine.
        turnRequest.endTurn({ forgetReport: true });
        if (snap.phase !== "waiting-photo") setSkipNotice(null);
        dispatchRound({ type: "game-state", snap, serverUrl: SERVER_URL });
        const result = gameStateFollowUps(snap);
        setPause(result.pause);
        if (result.gameOver) showGameOver(snap.scores);
        if (result.sendReady) socket.emit("im-ready");
        if (result.resendGuess && roundRef.current.mySelection) sendPick();
      },

      // Only the picker's emojis (and the screenshot one), only while a photo is shown, at most a few on screen
      "emoji-reaction": (data: { username: string; emoji: string }) => {
        if (!roundRef.current.photo || !isAllowedReaction(data?.emoji) || typeof data.username !== "string") return;
        const reaction = { id: `${Date.now()}-${Math.random()}`, username: data.username, emoji: data.emoji };
        setEmojiReactions((c) => appendCapped(c, reaction, MAX_VISIBLE_REACTIONS));
      },
    };

    // Someone left or was kicked: no longer an answer option (a disconnected player stays, they may come back)
    const dropPlayer = (name: string) => {
      setPlayers(withoutPlayer(playersRef.current, name));
      if (roundRef.current.phase === "answering" && roundRef.current.mySelection === name) pickGuess("");
    };
    // Kept on the final screens until unmount (still in the room)
    const roomHandlers: SocketHandlers = {
      "game-over": (data: { finalScore: ScoreRound[] }) => {
        console.log("[GAME] game-over");
        turnRequest.endTurn();
        showGameOver(data.finalScore);
      },
      "player-left": (name: string) => { console.log(`[GAME] player-left: ${name}`); dropPlayer(name); },
      "player-removed": (removed: Player) => { console.log(`[GAME] player-removed: ${removed.username}`); dropPlayer(removed.username); },
      "new-host": (host: Player) => setPlayers(withHost(playersRef.current, host.username)),
    };

    detachGameHandlers.current = attachHandlers(socket, gameHandlers);
    const detachRoomHandlers = attachHandlers(socket, roomHandlers);
    setIsReady(true);

    return () => {
      detachGameHandlers.current?.();
      detachRoomHandlers();
      detachFinalScreenHandlers.current?.();
      // The socket is not ended here: "Play again" reuses it (the lobby rejoins on the same socket); leaving for
      // home ends it there (Exit, or the home screen on focus)
    };
  }, [socket]);

  // Signal ready at once (whether a player is still uploading must not show). The planted photo was sent from the
  // lobby; only if that upload failed, retry it now (the server accepts it until round 1 is played)
  useEffect(() => {
    if (!isReady || !socket) return;
    console.log("Emitting im-ready");
    socket.emit("im-ready", { gameCode: safeGameCode, username: safeUsername });
    if (plantedPhotoUri && !plantedPhotoSent) plantPhoto();
  }, [isReady]);

  const handleWinnerEnd = () => { setShowWinner(false); setShowFinalScore(true); };
  // Reactions belong to the photo they were sent on: drop them whenever it changes (waiting-photo, resume, snapshot)
  useEffect(() => { setEmojiReactions([]); }, [photo]);
  const removeEmoji = (id: string) => setEmojiReactions((c) => c.filter((r) => r.id !== id));
  // Top edge of the answer buttons (measured): the reaction lane ends above it
  const [answersTop, setAnswersTop] = useState<number | null>(null);
  // Denser options in crowded rooms, in a bounded area that scrolls: the photo and the timer stay visible (EXP-250)
  const { height: windowHeight } = useWindowDimensions();
  const answersLayout = answerOptionsLayout(playersProvider.length, windowHeight);
  const optionCard = answersLayout.compact ? OPTION_CARD.compact : OPTION_CARD.regular;
  const answersListRef = useRef<FlatList<Player>>(null);
  // iOS only draws the scroll indicator while scrolling: flash it when some options are out of view
  const hintMoreAnswers = (_width: number, contentHeight: number) => {
    if (contentHeight > answersLayout.maxHeight) answersListRef.current?.flashScrollIndicators();
  };

  // ── Render helpers ───────────────────────────────────
  // The options are drawn while answering and in the reveal (not in scores: the scoreboard covers the photo)
  const isReveal = phase === "reveal";

  const renderPlayer = ({ item }: { item: Player }) => {
    // The answer is only known from round-reveal on (correctAnswer); before that nobody is told whose photo it is
    const isAnswer = item.username === correctAnswer;
    const isSelected = item.username === mySelection;
    const isMe = item.username === safeUsername;

    // Only color YOUR selection: blue while answering, then green if correct, red if wrong
    let bg = "bg-gray-700";
    if (isReveal && isSelected) {
      bg = isAnswer ? "bg-green-500" : "bg-red-500";
    } else if (isSelected) {
      bg = "bg-blue-500";
    }

    return (
      <TouchableOpacity
        testID={playerOptionId(item.username)}
        style={tw`${optionCard.card} rounded-lg mx-1 flex-grow ${OPTION_BASIS[answersLayout.columns]} ${bg}`}
        onPress={() => phase === "answering" && !answersClosed && item.username !== mySelection && pickGuess(item.username)}
        disabled={isReveal || answersClosed}
      >
        <View style={tw`flex-row items-center justify-between`}>
          <Text style={tw`text-white ${optionCard.text} flex-1 ${isMe ? "font-bold" : ""}`} numberOfLines={1} ellipsizeMode={optionCard.ellipsize}>
            {item.username}
          </Text>
          <View style={tw`flex-row items-center`}>
            {isMe && <Text style={tw`text-white text-xs bg-gray-600 px-1 py-0.5 rounded-full ml-1`}>{t.you}</Text>}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  // ── Main render ──────────────────────────────────────
  return (
    <View style={{ flex: 1 }}>
      <StatusBar hidden />
      <WinnerModal visible={showWinner} winners={winners} onAnimationEnd={handleWinnerEnd} />
      <FinalScoreModal visible={showFinalScore} finalScore={finalScore || []} />
      <PausedModal endsAt={finalScore ? null : pauseEndsAt} pause={pauseCount.pause} maxPauses={pauseCount.maxPauses} />
      <GalleryAccessModal
        access={finalScore || showWinner ? null : galleryGuard.blocked}
        onAllow={() => galleryGuard.check({ ask: true })}
        onSelectPhotos={galleryGuard.selectMore}
        onRetry={() => galleryGuard.check({ ask: false })}
        blocking
      />

      {/* Subtle indicator while socket.io reconnects; the game screen stays */}
      {!connected && !finalScore && (
        <View testID={TEST_IDS.reconnectingBanner} style={tw`absolute top-2 left-0 right-0 z-100 items-center`} pointerEvents="none">
          <Text style={tw`text-white text-sm bg-gray-800 bg-opacity-80 px-3 py-1 rounded-full`}>{t.reconnecting}</Text>
        </View>
      )}

      <View style={tw`flex-1 bg-black`}>
        {phase === "waiting-photo" ? (
          <View testID={TEST_IDS.gameWaitingPhoto} style={tw`flex-1 justify-center items-center px-6`}>
            {round > 0 && roundsOfGame > 0 && (
              <Text style={tw`text-gray-400 text-base mb-2`}>
                {t.roundOf.replace("{round}", String(round)).replace("{total}", String(roundsOfGame))}
              </Text>
            )}
            <Text testID={TEST_IDS.waitingPhotoText} style={tw`text-xl text-white font-bold text-center mb-6`}>
              {t.someoneChoosingPhoto}
            </Text>
            {phaseDuration > 0 && pauseEndsAt === null && (
              <View style={tw`w-full max-w-[500px]`}>
                <ProgressBar key={phaseKey} duration={phaseDuration} />
              </View>
            )}
            {skipNotice && (
              <Text testID={TEST_IDS.roundSkippedNotice} style={tw`text-yellow-300 text-base text-center mt-6`}>
                {skipNoticeText(t, skipNotice)}
              </Text>
            )}
          </View>
        ) : photo ? (
          <>
            {/* Server photos need the room credentials: never request one without them (black until ready) */}
            {photoHeaders && <PhotoComponent photoUrl={photo} headers={photoHeaders} />}

            {/* Emoji reactions: own lane between the progress bar and the answer buttons */}
            <EmojiReactionLane
              reactions={emojiReactions}
              top={REACTION_LANE_TOP}
              answersTop={answersTop}
              screenshotLabel={t.tookScreenshot}
              onReactionEnd={removeEmoji}
            />

            {/* Game overlay — hidden during hold so photo is visible */}
            {!gameHeld && (
              <View style={tw`z-8 absolute w-full h-full`}>
                {/* Progress bar during answering or scores */}
                {(phase === "answering" || phase === "scores") && phaseDuration > 0 && pauseEndsAt === null && (
                  <View testID={TEST_IDS.roundProgress} style={[tw`absolute left-0 right-0 p-4 items-center`, PROGRESS_BAR_AREA]}>
                    <View style={tw`w-full max-w-[500px]`}>
                      <ProgressBar
                        key={phaseKey}
                        duration={phaseDuration}
                        onEnd={phase === "answering" ? closeAnswers : undefined}
                      />
                    </View>
                  </View>
                )}

                {/* Player selection buttons: everyone's, the photo owner's too (they aren't told it's theirs) */}
                {showAnswers && (
                  <View
                    style={tw`absolute z-40 bottom-22 left-0 right-0 p-2 flex-row justify-center`}
                    onLayout={(e) => setAnswersTop(e.nativeEvent.layout.y)}
                  >
                    <FlatList
                      // numColumns can't change on a mounted list (players may leave mid-game): remount instead
                      key={`answers-${answersLayout.columns}`}
                      ref={answersListRef}
                      testID={TEST_IDS.answerOptions}
                      data={playersProvider}
                      renderItem={renderPlayer}
                      keyExtractor={(item) => item.username}
                      numColumns={answersLayout.columns}
                      columnWrapperStyle={tw`justify-between`}
                      style={[tw`w-full max-w-[500px] px-2`, { maxHeight: answersLayout.maxHeight }]}
                      contentContainerStyle={tw`w-full`}
                      showsVerticalScrollIndicator
                      persistentScrollbar
                      indicatorStyle="white"
                      onContentSizeChange={hintMoreAnswers}
                    />
                  </View>
                )}

                {/* Score modal */}
                <ScoreModal
                  visible={phase === "scores" && !!scores}
                  scoreRound={scores || []}
                  rounds={{ round, roundsOfGame: roundsOfGame }}
                  correctAnswer={correctAnswer}
                  myUsername={safeUsername}
                  reserveHoldButton={holdButtonMounted}
                />
              </View>
            )}

            {/* Hold button — mounted during scores for photo owner, invisible while pressing */}
            {holdButtonMounted && (
              <View style={tw`absolute bottom-24 left-0 right-0 z-60 items-center ${pressing ? "opacity-0" : ""}`}>
                <TouchableOpacity
                  testID={TEST_IDS.holdButton}
                  style={tw`bg-blue-600 p-4 rounded-xl w-[90%] max-w-[500px] border-2 border-blue-400 shadow-lg items-center`}
                  onPressIn={onHoldPress}
                  onPressOut={onHoldRelease}
                  activeOpacity={0.8}
                >
                  <Text style={tw`text-white text-lg font-bold`}>{t.holdPhoto}</Text>
                </TouchableOpacity>
              </View>
            )}

            <EmojisButton />
          </>
        ) : (
          <View testID={TEST_IDS.gameWaitingReady} style={tw`flex-1 justify-center items-center`}>
            <Text style={tw`text-xl text-white font-bold mb-4`}>{t.areYouReady}</Text>
          </View>
        )}
      </View>
    </View>
  );
};

export default GameScreen;
