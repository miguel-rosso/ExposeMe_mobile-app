import React, { useEffect, useState, useCallback, useRef } from "react";
import { View, Text, TouchableOpacity, StatusBar, FlatList, BackHandler } from "react-native";
import { useFocusEffect } from "expo-router";
import tw from "twrnc";
import { useGameContext } from "../providers/GameContext";
import {
  GamePausedData, GameResumedData, GameStateSnapshot, PhotoUnavailableReason, Player, RoundSkippedData, ScoreRound,
  WaitingPhotoData, YourTurnData,
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
import EmojiReaction from "@/app/components/IngameComunication/EmojiReaction";
import EmojisButton from "@/app/components/IngameComunication/EmojisButtons";
import { useI18n } from "../i18n";
import { applyRoundStart, RoundStartData } from "../utils/roundStart";
import { uploadPhoto } from "@/app/utils/uploadPhoto";
import { photoAuthHeaders, resolvePhotoAuth } from "@/app/utils/photoAuth";
import { applyGameState, turnUploadAction, TurnUpload } from "../utils/gameState";
import { applyWaitingPhoto, SkipNotice, skipNoticeFor, skipNoticeText } from "../utils/waitingPhoto";
import { useGameConnection } from "../hooks/useGameConnection";
import { withHost, withoutPlayer } from "../utils/roomPlayers";
import PausedModal from "@/app/components/modals/PausedModal";
import GalleryAccessModal from "@/app/components/modals/GalleryAccessModal";
import { useGalleryAccessGuard } from "@/app/hooks/useGalleryAccessGuard";
import { useScreenshotReaction } from "../hooks/useScreenshotReaction";
import { appendCapped, isAllowedReaction, MAX_VISIBLE_REACTIONS } from "../utils/reactions";

const { SERVER_URL } = getEnvVars();
const PICK_SEND_INTERVAL = 200; // ms between submit-answer sends (server: 10 per socket, refilled 5/s)

interface EmojiReactionData { id: string; username: string; emoji: string }
type Phase = "waiting-photo" | "answering" | "reveal" | "scores" | null;

const GameScreen = () => {
  const { t } = useI18n();
  const {
    username, gameCode, endSocket, socket, playersProvider, setPlayersProvider, roundsOfGame, plantedPhotoUri,
    plantedPhotoSent, plantPhoto, getRejoinToken, saveRejoinToken,
  } = useGameContext();
  const safeUsername = username ?? "";
  const safeGameCode = gameCode ?? "";
  const { pickGamePhoto, setPhotoUri } = usePhotoContext();
  const router = useRouter();
  // Photo access revoked / no photos left (re-checked on foreground): blocking overlay, the game screen stays
  const galleryGuard = useGalleryAccessGuard({ watch: true });
  // One screenshot listener for the whole game (EmojisButton remounts every round)
  useScreenshotReaction(socket);

  // ── Round state (reset each round) ───────────────────
  const [photo, setPhoto] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false); // this round's photo is mine (only the owner is told, EXP-128)
  const [round, setRound] = useState(0);
  const [phase, setPhase] = useState<Phase>(null);
  const [phaseDuration, setPhaseDuration] = useState(0);
  const [phaseKey, setPhaseKey] = useState(0);
  const [correctAnswer, setCorrectAnswer] = useState("");
  const [scores, setScores] = useState<ScoreRound[] | null>(null);
  const [mySelection, _setMySelection] = useState("");
  const mySelectionRef = useRef("");
  const setMySelection = (val: string) => { mySelectionRef.current = val; _setMySelection(val); };
  // My pick goes to the server as soon as it changes: answers are only taken while answering (EXP-148), the last counts.
  // Rapid taps are coalesced: at most one send per PICK_SEND_INTERVAL, then a trailing send of the latest pick (within
  // the server's 300 ms grace), so its per-socket rate limit never drops the pick that counts.
  // pickSentRef: the current pick was emitted while connected (one made offline is lost: the rejoin drops it)
  const pickSentRef = useRef(true);
  const lastPickSentAt = useRef(0);
  const pickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendPick = () => {
    pickTimer.current = null;
    lastPickSentAt.current = Date.now();
    pickSentRef.current = !!socket?.connected;
    socket?.emit("submit-answer", { guess: mySelectionRef.current });
  };
  const pickGuess = (val: string) => {
    setMySelection(val);
    pickSentRef.current = false;
    if (pickTimer.current) return; // the pending trailing send takes the latest pick
    const wait = lastPickSentAt.current + PICK_SEND_INTERVAL - Date.now();
    if (wait <= 0) { sendPick(); return; }
    const pickRound = roundRef.current.round;
    pickTimer.current = setTimeout(() => {
      // A new round (or its photo wait) started meanwhile: that pick belonged to the previous one
      if (roundRef.current.round === pickRound && roundRef.current.phase !== "waiting-photo") sendPick();
      else pickTimer.current = null;
    }, wait);
  };
  useEffect(() => () => { if (pickTimer.current) clearTimeout(pickTimer.current); }, []);
  // The answer bar (server duration) has run out: no more picks this phase (phaseKey changes with every phase/resume)
  const [answersClosedKey, setAnswersClosedKey] = useState(-1);
  const answersClosed = phase === "answering" && answersClosedKey === phaseKey;
  // Current round/photo for the game-state handler (socket listeners would see stale state)
  const roundRef = useRef<{ round: number; photo: string | null; phase: Phase }>({ round: 0, photo: null, phase: null });
  roundRef.current = { round, photo, phase };
  // Latest players list for the room-membership handlers; updated on write too, so back-to-back events
  // (new-host + player-left arrive together) build on each other
  const playersRef = useRef<Player[]>(playersProvider);
  playersRef.current = playersProvider;
  const setPlayers = (next: Player[]) => { playersRef.current = next; setPlayersProvider(next); };
  // Photo uploaded for my turn: re-sent if the server asks again (after a reconnect or a pause)
  const turnUploadRef = useRef<TurnUpload | null>(null);

  // ── Waiting for the photo ────────────────────────────
  const [turnUploading, setTurnUploading] = useState(false); // my turn: picking/uploading my photo
  const [skipNotice, setSkipNotice] = useState<SkipNotice | null>(null); // last skipped round, until round-start
  // Why I reported photo-unavailable this turn, for my own round-skipped notice
  const ownUnavailableRef = useRef<PhotoUnavailableReason | null>(null);
  // Photo request of mine in force (last your-turn), null once it is over (next wait, round, skip, pause, snapshot)
  const currentTurnRef = useRef<YourTurnData | null>(null);

  // ── Pause (fewer than 2 players connected) ───────────
  const [pauseEndsAt, setPauseEndsAt] = useState<number | null>(null);
  const [pauseCount, setPauseCount] = useState({ pause: 0, maxPauses: 0 });
  const setPause = (p: GamePausedData | null) => {
    setPauseEndsAt(p === null ? null : Date.now() + p.duration);
    if (p) setPauseCount({ pause: p.pause, maxPauses: p.maxPauses });
  };

  // ── Hold state ───────────────────────────────────────
  const [gameHeld, setGameHeld] = useState(false);  // server says game paused
  const [pressing, setPressing] = useState(false);   // my finger is on button

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
  // Hold button: mounted during scores phase for photo owner (or while pressing to catch onPressOut)
  const holdButtonMounted = isOwner && (phase === "scores" || pressing);

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
    if (!isOwner || !socket || pressing) return;
    if (phase !== "scores") return;
    setPressing(true);
    socket.emit("hold-start");
  };

  const onHoldRelease = () => {
    if (!pressing || !socket) return;
    setPressing(false);
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

  const showGameOver = (finalScore: ScoreRound[]) => {
    if (gameOverRef.current) return;
    gameOverRef.current = true;
    setPauseEndsAt(null);
    setFinalScore(finalScore);
    if (finalScore?.length > 0) { setWinners(getWinners(finalScore)); setShowWinner(true); }
  };

  // ── Socket listeners ─────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    // A your-turn flow (gallery pick, upload retries) can outlive its request: only the request in force may
    // send or report anything
    const isCurrentTurn = (turn: YourTurnData) => currentTurnRef.current?.attempt === turn.attempt;

    // No photo to send for my turn: tell the server so it skips now instead of making everyone wait
    const reportUnavailable = (reason: PhotoUnavailableReason, turn: YourTurnData) => {
      if (turnUploadRef.current?.attempt === turn.attempt) turnUploadRef.current = null;
      if (!isCurrentTurn(turn)) { console.log(`[GAME] stale turn ${turn.attempt} ended without a photo (${reason})`); return; }
      console.log(`[GAME] photo-unavailable (${reason})`);
      ownUnavailableRef.current = reason;
      setTurnUploading(false);
      socket.emit("photo-unavailable", { round: turn.round, attempt: turn.attempt });
    };

    // Whole room: a photo is awaited (the owner is not revealed). Comes right before my own your-turn.
    socket.on("waiting-photo", (data: WaitingPhotoData) => {
      console.log(`[GAME] waiting-photo: round ${data.round}, ${data.duration}ms`);
      currentTurnRef.current = null; // any earlier request of mine is over
      setTurnUploading(false);
      ownUnavailableRef.current = null; // a report of mine was answered by the round-skipped before this
      applyWaitingPhoto(data, {
        setPhoto, setIsOwner, setRound, setPhase, setPhaseDuration, setPhaseKey,
        setCorrectAnswer, setScores, setMySelection, setGameHeld, setPressing,
      });
    });

    // My turn: pick photo → upload → send (or report photo-unavailable)
    socket.on("your-turn", async (data: YourTurnData) => {
      currentTurnRef.current = data;
      setRound(data.round);
      setTurnUploading(true);
      ownUnavailableRef.current = null;
      const action = turnUploadAction(turnUploadRef.current, data.attempt);
      if (action === "resend") { socket.emit("photo-sent", { photo: turnUploadRef.current!.url }); return; }
      if (action === "wait") return; // the upload in flight sends it
      turnUploadRef.current = { attempt: data.attempt };
      try {
        const picked = await pickGamePhoto();
        if ("error" in picked) { reportUnavailable(picked.error, data); return; }
        for (let i = 1; i <= 3; i++) {
          try {
            console.log(`Upload attempt ${i}...`);
            const url = await uploadImage(picked.uri);
            console.log("Photo uploaded");
            setPhotoUri(null);
            // Kept for a re-sent your-turn of this request (e.g. it finished while paused)
            if (turnUploadRef.current?.attempt === data.attempt) turnUploadRef.current = { attempt: data.attempt, url };
            if (isCurrentTurn(data)) socket.emit("photo-sent", { photo: url });
            return;
          } catch (e) {
            console.error(`Attempt ${i} failed:`, e);
            if (i < 3) await new Promise((r) => setTimeout(r, 1000 * i));
          }
        }
        console.error("All upload attempts failed");
        reportUnavailable("upload", data);
        return;
      } catch (e) { console.error("your-turn error:", e); }
      reportUnavailable("failed", data);
    });

    // Atomic: new round — photo + answer timer
    socket.on("round-start", (data: RoundStartData) => {
      console.log(`[GAME] round-start: round=${data.round}, mine=${data.isOwner}`);
      currentTurnRef.current = null;
      setTurnUploading(false);
      setSkipNotice(null);
      applyRoundStart(data, SERVER_URL, {
        setPhoto, setIsOwner, setRound, setPhase, setPhaseDuration, setPhaseKey,
        setCorrectAnswer, setScores, setMySelection, setGameHeld, setPressing,
      });
    });

    // Atomic: answer revealed (my pick was already sent when tapped; the server froze answers before this)
    socket.on("round-reveal", (data: { correctAnswer: string; duration: number }) => {
      console.log(`[GAME] round-reveal: ${data.correctAnswer}, my guess: ${mySelectionRef.current}`);
      setPhase("reveal");
      setCorrectAnswer(data.correctAnswer);
      setPhaseDuration(data.duration);
      setPhaseKey((k) => k + 1);
    });

    // Atomic: scores displayed
    socket.on("round-scores", (data: { scores: ScoreRound[]; round: number; totalRounds: number; duration: number }) => {
      console.log(`[GAME] round-scores: round ${data.round}/${data.totalRounds}`);
      setPhase("scores");
      setScores(data.scores);
      setRound(data.round);
      setPhaseDuration(data.duration);
      setPhaseKey((k) => k + 1);
    });

    // Hold: everyone pauses
    socket.on("hold-start", () => {
      console.log("[GAME] hold-start");
      setGameHeld(true);
    });

    // Hold ended (from server force-release or another client)
    socket.on("hold-end", () => {
      console.log("[GAME] hold-end");
      setGameHeld(false);
      setPressing(false);
    });

    // Hold resume: phase continues with remaining time
    socket.on("hold-resume", (data: { phase: string; duration: number }) => {
      console.log(`[GAME] hold-resume: ${data.phase} ${data.duration}ms`);
      setGameHeld(false);
      setPressing(false);
      setPhaseDuration(data.duration);
      setPhaseKey((k) => k + 1);
    });

    // No photo for this round: say why on the waiting screen until the next round starts
    socket.on("round-skipped", (data: RoundSkippedData) => {
      console.log(`[GAME] round-skipped: round ${data.round} (${data.reason})`);
      setSkipNotice(skipNoticeFor(data, ownUnavailableRef.current));
      ownUnavailableRef.current = null;
      currentTurnRef.current = null;
      setTurnUploading(false);
    });

    // Fewer than 2 players connected: the server froze the game and shows its countdown
    socket.on("game-paused", (data: GamePausedData) => {
      console.log(`[GAME] game-paused ${data.pause}/${data.maxPauses}: ${data.duration}ms, waiting for ${data.waitingFor.join(", ")}`);
      setPause(data);
      setPressing(false);
      setGameHeld(false);
      // The server ignores photos while paused and sends your-turn again on resume (an upload that finishes
      // meanwhile is kept and re-sent then)
      currentTurnRef.current = null;
    });

    socket.on("game-resumed", (data: GameResumedData) => {
      console.log(`[GAME] game-resumed: ${data.phase} ${data.duration}ms`);
      setPauseEndsAt(null);
      // Paused between rounds (after scores): the next round's photo is awaited now
      if (data.phase === "waiting-photo" && roundRef.current.phase !== "waiting-photo") {
        setPhoto(null);
        setIsOwner(false);
        setScores(null);
        setPhase("waiting-photo");
        setRound(roundRef.current.round + 1);
      }
      setPhaseDuration(data.duration);
      setPhaseKey((k) => k + 1);
    });

    // Snapshot after a rejoin: render whatever phase the server is in
    socket.on("game-state", (snap: GameStateSnapshot) => {
      console.log(`[GAME] game-state: ${snap.phase} round ${snap.round}, paused=${!!snap.pause}`);
      setPlayers(snap.players);
      // An awaited photo of mine is asked again with your-turn right after this snapshot
      currentTurnRef.current = null;
      setTurnUploading(false);
      if (snap.phase !== "waiting-photo") setSkipNotice(null);
      const result = applyGameState(snap, SERVER_URL, { ...roundRef.current, pickSent: pickSentRef.current }, {
        setPhoto, setIsOwner, setRound, setPhase, setPhaseDuration, setPhaseKey,
        setCorrectAnswer, setScores, setMySelection, setGameHeld, setPressing, setPause,
      });
      if (result.gameOver) showGameOver(snap.scores);
      if (result.sendReady) socket.emit("im-ready");
      if (result.resendGuess && mySelectionRef.current) {
        socket.emit("submit-answer", { guess: mySelectionRef.current });
        pickSentRef.current = true;
      }
    });

    socket.on("game-over", (data: { finalScore: ScoreRound[] }) => {
      console.log("[GAME] game-over");
      currentTurnRef.current = null;
      showGameOver(data.finalScore);
    });

    // Someone left or was kicked: no longer an answer option (a disconnected player stays, they may come back)
    const dropPlayer = (name: string) => {
      setPlayers(withoutPlayer(playersRef.current, name));
      if (roundRef.current.phase === "answering" && mySelectionRef.current === name) pickGuess("");
    };
    socket.on("player-left", (name: string) => { console.log(`[GAME] player-left: ${name}`); dropPlayer(name); });
    socket.on("player-removed", (removed: Player) => { console.log(`[GAME] player-removed: ${removed.username}`); dropPlayer(removed.username); });
    socket.on("new-host", (host: Player) => setPlayers(withHost(playersRef.current, host.username)));

    // Only the picker's emojis (and the screenshot one), only while a photo is shown, at most a few on screen
    socket.on("emoji-reaction", (data: { username: string; emoji: string }) => {
      if (!roundRef.current.photo || !isAllowedReaction(data?.emoji) || typeof data.username !== "string") return;
      const reaction = { id: `${Date.now()}-${Math.random()}`, username: data.username, emoji: data.emoji };
      setEmojiReactions((c) => appendCapped(c, reaction, MAX_VISIBLE_REACTIONS));
    });

    setIsReady(true);

    return () => {
      socket.off("waiting-photo"); socket.off("your-turn"); socket.off("round-start"); socket.off("round-reveal");
      socket.off("round-scores"); socket.off("hold-start"); socket.off("hold-end");
      socket.off("hold-resume"); socket.off("round-skipped"); socket.off("game-over");
      socket.off("emoji-reaction"); socket.off("game-paused"); socket.off("game-resumed"); socket.off("game-state");
      socket.off("player-left"); socket.off("player-removed"); socket.off("new-host");
      endSocket();
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

  // ── Render helpers ───────────────────────────────────
  const isRevealOrScores = phase === "reveal" || phase === "scores";

  const renderPlayer = ({ item }: { item: Player }) => {
    // The answer is only known from round-reveal on (correctAnswer); before that nobody is told whose photo it is
    const isAnswer = item.username === correctAnswer;
    const isSelected = item.username === mySelection;
    const isMe = item.username === safeUsername;

    // Only color YOUR selection: green if correct, red if wrong
    let bg = "bg-gray-700";
    if (isRevealOrScores && isSelected) {
      bg = isAnswer ? "bg-green-500" : "bg-red-500";
    } else if (!isRevealOrScores && isSelected) {
      bg = "bg-blue-500";
    }

    return (
      <TouchableOpacity
        testID={playerOptionId(item.username)}
        style={tw`p-3 rounded-lg mb-2 mx-1 flex-grow flex-basis-[48%] ${bg}`}
        onPress={() => phase === "answering" && !answersClosed && !isOwner && item.username !== mySelection && pickGuess(item.username)}
        disabled={isRevealOrScores || isOwner || answersClosed}
      >
        <View style={tw`flex-row items-center justify-between`}>
          <Text style={tw`text-white text-base flex-1 ${isMe ? "font-bold" : ""}`} numberOfLines={1} ellipsizeMode="tail">
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
              {turnUploading ? t.uploadingYourPhoto : t.someoneChoosingPhoto}
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

            {/* Emoji reactions */}
            <View style={tw`absolute top-4 left-4 z-90`}>
              {emojiReactions.map((r) => (
                <EmojiReaction key={r.id} username={r.username} emoji={r.emoji} screenshotLabel={t.tookScreenshot} onAnimationEnd={() => removeEmoji(r.id)} />
              ))}
            </View>

            {/* Game overlay — hidden during hold so photo is visible */}
            {!gameHeld && (
              <View style={tw`z-8 absolute w-full h-full`}>
                {/* Progress bar during answering or scores */}
                {(phase === "answering" || phase === "scores") && phaseDuration > 0 && pauseEndsAt === null && (
                  <View style={tw`absolute top-15 left-0 right-0 p-4 items-center`}>
                    <View style={tw`w-full max-w-[500px]`}>
                      <ProgressBar
                        key={phaseKey}
                        duration={phaseDuration}
                        onEnd={phase === "answering" ? () => setAnswersClosedKey(phaseKey) : undefined}
                      />
                    </View>
                  </View>
                )}

                {/* Player selection buttons (my own photo: I can't vote, so a hint instead while the others answer) */}
                <View style={tw`absolute z-40 bottom-22 left-0 right-0 p-2 flex-row justify-center`}>
                  {isOwner && phase === "answering" ? (
                    <Text
                      testID={TEST_IDS.ownPhotoHint}
                      style={tw`text-white text-lg font-bold text-center bg-gray-800 bg-opacity-80 px-4 py-3 rounded-xl max-w-[500px]`}
                    >
                      {t.ownPhotoHint}
                    </Text>
                  ) : (
                    <FlatList
                      data={playersProvider}
                      renderItem={renderPlayer}
                      keyExtractor={(item) => item.username}
                      numColumns={2}
                      columnWrapperStyle={tw`justify-between`}
                      style={tw`w-full max-w-[500px] px-2`}
                      contentContainerStyle={tw`w-full`}
                    />
                  )}
                </View>

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
