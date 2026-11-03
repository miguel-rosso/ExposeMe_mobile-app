import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  View, Text, TouchableOpacity, StatusBar, LayoutChangeEvent, useWindowDimensions, ActivityIndicator, Alert,
} from "react-native";
import { useLocalSearchParams, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import tw from "twrnc";
import { useGameContext } from "../../src/providers/GameContext";
import {
  GamePausedData, GameResumedData, GameStateSnapshot, HoldEndData, HoldResumeData, Player, RoundRevealData,
  RoundScoresData, RoundSkippedData, RoundStartData, ScoreRound, WaitingPhotoData, YourTurnData,
} from "../../src/models/interfaces";
import { usePhotoContext } from "../../src/providers/PhotoContext";
import { useRouter } from "expo-router";
import getEnvVars from "@/config";
import PhotoComponent from "@/src/components/PhotoComponent";
import ScoreModal from "@/src/components/modals/ScoreModal";
import { TEST_IDS } from "@/src/utils/testIds";
import ProgressBar from "@/src/components/ProgressBar";
import FinalScoreModal from "@/src/components/modals/FinalScoreModal";
import WinnerModal from "@/src/components/modals/WinnerModal";
import { getWinners, hasResult } from "@/src/utils/ranking";
import RoomReactionLane from "@/src/components/IngameComunication/RoomReactionLane";
import EmojisButton from "@/src/components/IngameComunication/EmojisButtons";
import AnswerOption, { answerOptionState } from "@/src/components/AnswerOption";
import AnswerOptionsGrid from "@/src/components/AnswerOptionsGrid";
import DeferredMount from "@/src/components/DeferredMount";
import { useI18n } from "../../src/i18n";
import { uploadPhoto } from "@/src/utils/uploadPhoto";
import { photoAuthHeaders, resolvePhotoAuth } from "@/src/utils/photoAuth";
import { prefetchImage } from "@/src/utils/image";
import { photoWaitOf, pickAndUploadTurnPhoto } from "../../src/utils/turnPhoto";
import { SkipNotice, skipNoticeFor, skipNoticeText } from "../../src/utils/waitingPhoto";
import {
  gameStateFollowUps, isAnotherGame, isRevealedOwner, phaseElapsed, RoundAction, roundOptions,
  roundReducer, RoundView, roundViewOfGame,
} from "../../src/utils/roundState";
import { emitWhileConnected } from "../../src/utils/socketEmit";
import { useGameConnection } from "../../src/hooks/useGameConnection";
import { useTurnRequest } from "../../src/hooks/useTurnRequest";
import { usePickSender } from "../../src/hooks/usePickSender";
import { withHost, withoutPlayer } from "../../src/utils/roomPlayers";
import PausedModal from "@/src/components/modals/PausedModal";
import LeaveGameConfirm from "@/src/components/modals/LeaveGameConfirm";
import LeaveGameButton from "@/src/components/LeaveGameButton";
import { useFocusedBackHandler } from "../../src/hooks/useFocusedBackHandler";
import GalleryAccessModal from "@/src/components/modals/GalleryAccessModal";
import { useGalleryAccessGuard } from "@/src/hooks/useGalleryAccessGuard";
import { useQaRenderAck } from "../../src/hooks/useQaRenderAck";
import { useScreenshotReaction } from "../../src/hooks/useScreenshotReaction";
import { answerOptionsLayout } from "../../src/utils/answerOptionsLayout";
import { usePlayerColors } from "../../src/hooks/usePlayerColors";
import { useReduceMotion } from "../../src/hooks/useReduceMotion";
import { attachHandlers, SocketHandlers } from "../../src/utils/socketHandlers";
import { safeBottomRow, safeTopRow } from "../../src/utils/safeAreaRows";
import { ANSWERS_BOTTOM, HOLD_BUTTON_BOTTOM } from "../../src/utils/gameRows";
import { PROGRESS_BAR_AREA, progressBarAreaBottom, progressBarRow } from "../../src/utils/progressBarRow";
import {
  GAME_SCREEN_PATH, GameScreenParams, openingGameNumber, opensOnGameInProgress,
} from "../../src/utils/gameScreenRoute";
import { useGoHome } from "../../src/hooks/useGoHome";
import { isKickedByHost, KICKED_BY_HOST_MESSAGE } from "../../src/utils/serverMessage";

const { SERVER_URL } = getEnvVars();
// Rows over the photo (see safeAreaRows; the progress bar strip is in progressBarRow, the bottom ones in gameRows)
const RECONNECTING_BANNER = { top: 8, margin: 8 } as const;
const NO_SCORES: ScoreRound[] = [];

const GameScreen = () => {
  const { t } = useI18n();
  const {
    username, gameCode, socket, playersProvider, setPlayersProvider, roundsOfGame, plantedPhotoUri,
    plantedPhotoSent, plantPhoto, getRejoinToken, saveRejoinToken, clearRejoinToken, setPlantedPhotoUri,
    takeInviteOverRoomScreen, leaveRoom,
  } = useGameContext();
  const safeUsername = username ?? "";
  const safeGameCode = gameCode ?? "";
  const { pickGamePhoto, resetUsedPhotos } = usePhotoContext();
  // One game screen per game (reconnects stay on it): a new screen is a new game, earlier photos may come up again.
  // Optional call: screen tests mock the photo context with only what their flow needs.
  useEffect(() => { resetUsedPhotos?.(); }, [resetUsedPhotos]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const progressRow = progressBarRow(insets);
  // Photo access revoked / no photos left (re-checked on foreground): blocking overlay, the game screen stays
  const galleryGuard = useGalleryAccessGuard({ watch: true });
  // One screenshot listener for the whole game (EmojisButton remounts every round)
  useScreenshotReaction(socket);

  // ── Round state (reset each round) ───────────────────
  const routeParams = useLocalSearchParams<GameScreenParams>();
  // Opened from game-started: the game is known from the start, so a rejoin snapshot of the next one, before this
  // game's first round event, is told apart (EXP-384)
  const [openingView] = useState(() => roundViewOfGame(openingGameNumber(routeParams)));
  // roundRef always holds the latest state, updated on dispatch: socket listeners and timers read it (their closures
  // would see stale state), and back-to-back events build on each other. The screen renders roundView.
  const roundRef = useRef<RoundView>(openingView);
  // Room photo credentials for the round-photo prefetch (set with photoHeaders, below)
  const photoHeadersRef = useRef<Record<string, string> | undefined>(undefined);
  const [roundView, setRoundView] = useState<RoundView>(openingView);
  // Opened on a game in progress (a rejoin from the lobby): its phase is unknown until the server's snapshot, so a
  // neutral loader is shown instead of the ready phase's "waiting for everyone to be ready" (EXP-289)
  const [awaitingSnapshot, setAwaitingSnapshot] = useState(() => opensOnGameInProgress(routeParams));
  // Device time the event that started the current phase (a new phaseKey) arrived: its progress bar ends `phaseDuration`
  // after it, not after the phase's paint, which can come much later on slow phones (EXP-300)
  const [phaseStartedAt, setPhaseStartedAt] = useState(0);
  const dispatchRound = (action: RoundAction) => {
    const { photo: previousPhoto, phaseKey: previousPhaseKey } = roundRef.current;
    roundRef.current = roundReducer(roundRef.current, action);
    setRoundView(roundRef.current);
    if (roundRef.current.phaseKey !== previousPhaseKey) setPhaseStartedAt(Date.now());
    const { photo: currentPhoto } = roundRef.current;
    if (currentPhoto === previousPhoto) return;
    // A new round photo (round-start, snapshot) starts downloading now, while the screen renders and mounts (EXP-119)
    if (currentPhoto && photoHeadersRef.current) prefetchImage(currentPhoto, photoHeadersRef.current);
  };
  const {
    photo, round, phase, phaseDuration, phaseKey, correctAnswer, scores, mySelection, gameHeld, pressing, noHoldsLeft,
    leavers,
  } = roundView;
  // The server's count once it sent one (a game started while I was away may have another), else the lobby's setting
  const totalRounds = roundView.totalRounds || roundsOfGame;
  // QA builds only: tells the server when this device rendered each phase (lab render-skew metrics); the phase
  // handlers below call markPhaseHandled first, so the ack also says when their event arrived
  const markPhaseHandled = useQaRenderAck(socket, phase, round, phaseKey);
  // My pick goes to the server as soon as it changes (throttled, see usePickSender): answers are only taken while
  // answering (EXP-148), the last counts. When the answer bar ends, a pick still waiting goes at once and later taps
  // are ignored.
  const pickSender = usePickSender(socket, roundRef);
  const pickGuess = (val: string) => {
    dispatchRound({ type: "pick", guess: val });
    pickSender.pickChanged();
  };
  // The answer bar (server duration) has run out: no more picks this phase (phaseKey changes with every phase/resume)
  const [answersClosedKey, setAnswersClosedKey] = useState(-1);
  const answersClosed = phase === "answering" && answersClosedKey === phaseKey;
  const closeAnswers = () => {
    pickSender.flushPending(); // the pick waiting for its throttle slot must leave before the close
    setAnswersClosedKey(phaseKey);
  };
  // Latest players list for the room-membership handlers; updated on write too, so back-to-back events
  // (new-host + player-left arrive together) build on each other
  const playersRef = useRef<Player[]>(playersProvider);
  playersRef.current = playersProvider;
  const setPlayers = (next: Player[]) => { playersRef.current = next; setPlayersProvider(next); };

  // ── Waiting for the photo ────────────────────────────
  // My own photo request (your-turn): ended (or, on a pause, suspended) by every TURN_ENDING_EVENTS handler below
  const turnRequest = useTurnRequest(socket);
  const [skipNotice, setSkipNotice] = useState<SkipNotice | null>(null); // last skipped round, until round-start

  // ── Pause (fewer than 2 players connected) ───────────
  const [pauseEndsAt, setPauseEndsAt] = useState<number | null>(null);
  const [pauseInfo, setPauseInfo] = useState<Omit<GamePausedData, "duration">>({ pause: 0, maxPauses: 0, waitingFor: [] });
  const setPause = (p: GamePausedData | null) => {
    setPauseEndsAt(p === null ? null : Date.now() + p.duration);
    if (p) setPauseInfo({ pause: p.pause, maxPauses: p.maxPauses, waitingFor: p.waitingFor });
  };

  // ── End game ─────────────────────────────────────────
  const [finalScore, setFinalScore] = useState<ScoreRound[] | null>(null);
  const [showFinalScore, setShowFinalScore] = useState(false);
  const [showWinner, setShowWinner] = useState(false);
  const [winners, setWinners] = useState<ScoreRound[]>([]);
  const gameOverRef = useRef(false);

  // ── Other ────────────────────────────────────────────
  const [isReady, setIsReady] = useState(false);

  // ── Derived ──────────────────────────────────────────
  // Hold button: the photo owner's, during scores only (every event that ends scores also clears the press). Like
  // everyone, the owner only learns the photo was theirs from the reveal (EXP-252)
  const holdButtonMounted = phase === "scores" && isRevealedOwner(correctAnswer, safeUsername);
  // The scoreboard covers the photo in scores: the answer options are not drawn under it
  const showAnswers = phase !== "scores";
  // A resumed phase's bar starts where it was, not empty (EXP-080)
  const phaseBarElapsed = phaseElapsed(roundView);

  // ── Photo access (room members only: room code + rejoin token) ─
  // The room this screen plays in: the first one it is given. An invite link's Join switches the app to the linked
  // room while this screen is still on its way out (EXP-369): that room's session is its own lobby's business, never
  // looked up nor uploaded with here. Leaving the game forgets the room (EXP-342): no session either.
  const screenRoomRef = useRef<string | null>(null);
  if (gameCode) screenRoomRef.current ??= gameCode;
  /** The room code while the app is still in this screen's room, else null */
  const ownRoomCode = gameCode === screenRoomRef.current ? gameCode : null;
  const uploadImage = async (uri: string): Promise<string> =>
    uploadPhoto(SERVER_URL, uri, await resolvePhotoAuth(getRejoinToken, ownRoomCode, username));
  const [photoHeaders, setPhotoHeaders] = useState<Record<string, string> | undefined>(undefined);
  useEffect(() => {
    // Out of this screen's room: no session to look up, nothing to warn about
    if (!ownRoomCode) return;
    let live = true;
    resolvePhotoAuth(getRejoinToken, ownRoomCode, username)
      .then((auth) => {
        if (!live) return;
        photoHeadersRef.current = photoAuthHeaders(auth);
        setPhotoHeaders(photoHeadersRef.current);
      })
      .catch(() => console.warn("[GAME] no session token: room photos can't be loaded"));
    return () => { live = false; };
  }, [ownRoomCode, username]);

  // ── Leaving this screen ──────────────────────────────
  // router.replace acts on the top screen: anything opened over this one (an invite link's dialog, EXP-360, even one
  // whose push is queued in the same tick) is dismissed first, so that it is always this screen that is replaced
  const replaceThisScreen = (href: Href) => {
    router.dismissTo(GAME_SCREEN_PATH);
    router.replace(href);
  };

  // ── Hold handlers ────────────────────────────────────
  // Offline, a press is not sent: the rejoin's snapshot releases it (game-state clears `pressing`). Once the server says
  // no hold can start any more this round (holds used up, or the scoreboard's last moments: hold-closed) the button is
  // disabled and a press sends nothing (it would be ignored); a press already down still sends its release
  const onHoldPress = () => {
    if (!holdButtonMounted || !socket || pressing || noHoldsLeft) return;
    dispatchRound({ type: "pressing", pressing: true });
    emitWhileConnected(socket, "hold-start");
  };

  const onHoldRelease = () => {
    if (!pressing || !socket) return;
    dispatchRound({ type: "pressing", pressing: false });
    emitWhileConnected(socket, "hold-end");
  };

  // ── Leaving for home ─────────────────────────────────
  // Out of the game for good (kicked, room gone, rejoin or connection refused): home, which shows the reason in my
  // language. Only once: the server closes the socket right after my own player-removed. Kicked (player-removed, or a
  // rejoin refused for it after missing that offline): my rejoin token is dead, so it is forgotten
  const leftGameRef = useRef(false);
  // Back to the home under this screen, closing anything opened over it too
  const goHome = useGoHome();
  const leaveGame = (message?: string) => {
    if (leftGameRef.current) return;
    leftGameRef.current = true;
    if (isKickedByHost(message)) clearRejoinToken();
    console.log("[GAME] Out of the game — returning to menu");
    goHome(message);
  };

  // ── Leaving on purpose (EXP-377, DEC-050 A) ──────────
  // Exit (the game's button, the pause modal's, Android back) asks first. Leave sends leave-room, which the server takes
  // as a real leave (DEC-011: the game goes on for the others, or ends if one is left) instead of a lost connection
  // that would pause it, and forgets my rejoin token: I can't come back. Game over closes the question: the final
  // screens have their own Exit.
  const [askingToLeave, setAskingToLeave] = useState(false);
  const leaveForGood = () => {
    setAskingToLeave(false);
    if (leftGameRef.current) return;
    leaveRoom();
    leaveGame();
  };
  // Android back (the key and the back gesture) never pops the game (the server would take it as a lost connection):
  // during the game it is Exit, and with the question open its Cancel. iOS has no back here (the route disables the
  // swipe, app/_layout.tsx)
  useFocusedBackHandler(() => {
    if (!gameOverRef.current) setAskingToLeave((asking) => !asking);
    return true;
  });

  // ── Connection: stay in the game, rejoin on reconnect ─
  const { connected } = useGameConnection({
    socket, gameCode, username, getRejoinToken, saveRejoinToken,
    onLeave: leaveGame,
    planted: { uri: plantedPhotoUri, sent: plantedPhotoSent, plant: plantPhoto },
  });

  // Removers of this screen's own socket listeners (never socket.off(event): the socket is shared, see socketHandlers).
  // The game ones go at game over, the final screens' ones (attached then) on unmount.
  const detachGameHandlers = useRef<(() => void) | null>(null);
  const detachFinalScreenHandlers = useRef<(() => void) | null>(null);

  // Join the next game the host started (DEC-018 A) the same way "Play again" does: the lobby rejoins on this socket,
  // gets the started game's snapshot and opens a fresh game screen (new used-photos list, the server's round count),
  // which sends im-ready. This screen's game is over: it stops driving it at once.
  const joiningNextGameRef = useRef(false);
  const joinNextGame = () => {
    if (joiningNextGameRef.current) return;
    joiningNextGameRef.current = true;
    console.log("[GAME] next game started — joining it");
    detachGameHandlers.current?.();
    setPlantedPhotoUri(null); // planted for the game that ended
    const closedInvite = takeInviteOverRoomScreen();
    replaceThisScreen("/screens/WaitingRoom");
    // An invite link's dialog asking over this screen closes with it: the player is told why (DEC-049)
    if (closedInvite) {
      Alert.alert(t.inviteClosedTitle, t.inviteClosedByNextGame.replace("{room}", closedInvite), [{ text: t.ok }]);
    }
  };

  const showGameOver = (finalScore: ScoreRound[]) => {
    if (gameOverRef.current) return;
    gameOverRef.current = true;
    detachGameHandlers.current?.();
    // Still in the room on the final screens: when the host starts the next game, join it at once. A snapshot of a
    // started game (I reconnected meanwhile) means the same thing.
    if (socket) {
      detachFinalScreenHandlers.current = attachHandlers(socket, {
        "game-started": joinNextGame,
        "game-state": (snap: GameStateSnapshot) => { if (snap?.started) joinNextGame(); },
        // Until then, if the next game picks me, say at once there is no photo so nobody waits the 15 s photo timeout
        // (the photo is never picked from here; offline, the rejoin asks again with a new your-turn)
        "your-turn": (turn: YourTurnData) => {
          emitWhileConnected(socket, "photo-unavailable", { round: turn?.round, attempt: turn?.attempt });
        },
      });
    }
    setPauseEndsAt(null);
    setFinalScore(finalScore);
    // Nobody scored (no rounds played, or everyone at 0): no winner to celebrate, straight to the table (DEC-044)
    if (hasResult(finalScore ?? [])) {
      setWinners(getWinners(finalScore));
      setShowWinner(true);
    } else {
      setShowFinalScore(true);
    }
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
          const result = await pickAndUploadTurnPhoto({
            pick: pickGamePhoto,
            upload: uploadImage,
            // Retries go on while this request is in force or paused, and stop once it is over
            stillWanted: () => turnRequest.isCurrent(data) || turnRequest.isSuspended(data),
            // The photo wait the server gave (waiting-photo, or what a resume or snapshot left of it) bounds the
            // retries and the re-picks of a photo that can't be converted (EXP-292); a pause freezes it
            photoWait: () => photoWaitOf(roundRef.current),
            paused: () => turnRequest.isSuspended(data),
          });
          if ("error" in result) { turnRequest.reportUnavailable(result.error, data); return; }
          turnRequest.sendPhoto(data, result.url);
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

      // Atomic: answer revealed, with my answer as the server froze it (the pick the reveal colours)
      "round-reveal": (data: RoundRevealData) => {
        markPhaseHandled("reveal");
        console.log(`[GAME] round-reveal: ${data.correctAnswer}, my guess: ${data.yourGuess}`);
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
      "hold-end": (data: HoldEndData) => {
        console.log(`[GAME] hold-end: ${data.holdsLeft} left`);
        dispatchRound({ type: "hold-end", data });
      },

      // Hold resume: phase continues with remaining time
      "hold-resume": (data: HoldResumeData) => {
        console.log(`[GAME] hold-resume: ${data.phase} ${data.duration}ms`);
        dispatchRound({ type: "hold-resume", data });
      },

      // The running scoreboard is down to its last moments: no hold can start any more this round
      "hold-closed": () => {
        console.log("[GAME] hold-closed");
        dispatchRound({ type: "hold-closed" });
      },

      // No photo for this round: say why on the waiting screen until the next round starts
      "round-skipped": (data: RoundSkippedData) => {
        console.log(`[GAME] round-skipped: round ${data.round} (${data.reason ?? "room copy, no reason"})`);
        setSkipNotice(skipNoticeFor(data, turnRequest.takeReportedReason()));
        turnRequest.endTurn();
      },

      // Fewer than 2 players connected: the server froze the game and shows its countdown
      "game-paused": (data: GamePausedData) => {
        console.log(`[GAME] game-paused ${data.pause}/${data.maxPauses}: ${data.duration}ms, waiting for ${data.waitingFor.join(", ")}`);
        setPause(data);
        dispatchRound({ type: "game-paused" });
        // My photo request is only suspended: its pick, upload and retries go on (the server accepts the upload while
        // paused), nothing is sent until the resume's your-turn (same attempt), which re-sends the uploaded photo
        turnRequest.endTurn({ suspended: true });
      },

      "game-resumed": (data: GameResumedData) => {
        console.log(`[GAME] game-resumed: ${data.phase} ${data.duration}ms`);
        setPauseEndsAt(null);
        dispatchRound({ type: "game-resumed", data });
      },

      // Snapshot after a rejoin: render whatever phase the server is in
      "game-state": (snap: GameStateSnapshot) => {
        console.log(`[GAME] game-state: ${snap.phase} round ${snap.round}, paused=${!!snap.pause}`);
        // This game ended while I was away and the next one (another game number) already started (EXP-302, EXP-318):
        // its game-over and final scores are lost, so join the new game as the final screens would
        if (isAnotherGame(roundRef.current, snap)) {
          turnRequest.endTurn();
          joinNextGame();
          return;
        }
        setPlayers(snap.players);
        // An awaited photo of mine is asked again with your-turn right after this snapshot. A report of mine was
        // answered while I was away (that round-skipped is lost): a later skip is not mine. A paused game only
        // suspends my request (its upload goes on, like on game-paused).
        turnRequest.endTurn({ forgetReport: true, suspended: !!snap.pause });
        if (snap.phase !== "waiting-photo") setSkipNotice(null);
        setAwaitingSnapshot(false);
        dispatchRound({ type: "game-state", snap, serverUrl: SERVER_URL });
        const result = gameStateFollowUps(snap);
        setPause(result.pause);
        if (result.gameOver) showGameOver(snap.scores);
        if (result.sendReady) socket.emit("im-ready");
        if (result.resendGuess) pickSender.resendAfterRejoin();
      },
    };

    // Someone left or was kicked: out of the room (a disconnected player stays, they may come back). During a round
    // they stay one of its options, and my pick on them stands, until the next photo wait (DEC-038, see roundOptions)
    const dropPlayer = (name: string) => {
      const player = playersRef.current.find((p) => p.username === name);
      if (!player) return;
      const index = roundOptions(playersRef.current, roundRef.current.leavers).indexOf(player);
      dispatchRound({ type: "player-left", leaver: { player, index } });
      setPlayers(withoutPlayer(playersRef.current, name));
    };
    // Kept on the final screens until unmount (still in the room)
    const roomHandlers: SocketHandlers = {
      "game-over": (data: { finalScore: ScoreRound[] }) => {
        console.log("[GAME] game-over");
        turnRequest.endTurn();
        showGameOver(data.finalScore);
      },
      "player-left": (name: string) => { console.log(`[GAME] player-left: ${name}`); dropPlayer(name); },
      // The host can only remove players between games, so mine reaches me on the final screens: home, telling why
      "player-removed": (removed: Player) => {
        console.log(`[GAME] player-removed: ${removed.username}`);
        if (removed.username === safeUsername) leaveGame(KICKED_BY_HOST_MESSAGE);
        else dropPlayer(removed.username);
      },
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
  // lobby; only if that upload failed, retry it now (the server accepts it until round 1 is played). Offline, the
  // rejoin's snapshot of the ready phase sends im-ready instead
  useEffect(() => {
    if (!isReady || !socket) return;
    const sent = emitWhileConnected(socket, "im-ready", { gameCode: safeGameCode, username: safeUsername });
    console.log(sent ? "Emitting im-ready" : "im-ready deferred to the rejoin snapshot");
    if (plantedPhotoUri && !plantedPhotoSent) plantPhoto();
  }, [isReady]);

  const handleWinnerEnd = () => { setShowWinner(false); setShowFinalScore(true); };
  // The photo of the latest round event, for the reaction lane (stable: the lane is memoised)
  const latestPhoto = useCallback(() => roundRef.current.photo, []);
  // Top edge of the answer buttons (measured): the reaction lane ends above it
  const [answersTop, setAnswersTop] = useState<number | null>(null);
  const onAnswersLayout = useCallback((e: LayoutChangeEvent) => setAnswersTop(e.nativeEvent.layout.y), []);
  // Denser options in crowded rooms, in a bounded area that scrolls: the photo and the timer stay visible (EXP-250).
  // Kept stable for the memoised options grid
  const { height: windowHeight } = useWindowDimensions();
  const answerPlayers = useMemo(() => roundOptions(playersProvider, leavers), [playersProvider, leavers]);
  const answersLayout = useMemo(
    () => answerOptionsLayout(answerPlayers.length, windowHeight), [answerPlayers.length, windowHeight],
  );

  // ── Render helpers ───────────────────────────────────
  // Stable props for the memoised scoreboard: the game screen re-renders during scores (hold)
  const scoreRounds = useMemo(() => ({ round, roundsOfGame: totalRounds }), [round, totalRounds]);
  // The options are drawn while answering and in the reveal (not in scores: the scoreboard covers the photo)
  const isReveal = phase === "reveal";

  // The options are memoised and get a stable pick handler that reads the latest state: a re-render of the screen (or
  // a pick) only re-renders the options whose look changed (EXP-225)
  const pickOptionRef = useRef<(username: string) => void>(() => {});
  pickOptionRef.current = (username) => {
    if (phase === "answering" && !answersClosed && username !== mySelection) pickGuess(username);
  };
  const onPickOption = useCallback((username: string) => pickOptionRef.current(username), []);
  // Each player's colour, fixed for the game and the same on every device (EXP-253)
  const optionColors = usePlayerColors(answerPlayers);
  const reduceMotion = useReduceMotion();

  const renderAnswerOption = useCallback((player: Player, index: number) => (
    <AnswerOption
      username={player.username}
      index={index}
      state={answerOptionState(player.username, { mySelection, correctAnswer, isReveal })}
      color={optionColors.get(player.username)!}
      isMe={player.username === safeUsername}
      youLabel={t.you}
      columns={answersLayout.columns}
      compact={answersLayout.compact}
      disabled={isReveal || answersClosed}
      animate={!reduceMotion}
      onPick={onPickOption}
    />
  ), [
    mySelection, correctAnswer, isReveal, optionColors, safeUsername, t.you, answersLayout.columns, answersLayout.compact,
    answersClosed, reduceMotion, onPickOption,
  ]);

  // ── Main render ──────────────────────────────────────
  return (
    <View style={{ flex: 1 }}>
      <StatusBar hidden />
      <WinnerModal visible={showWinner} winners={winners} onAnimationEnd={handleWinnerEnd} />
      <FinalScoreModal visible={showFinalScore} finalScore={finalScore || []} />
      <PausedModal
        endsAt={finalScore ? null : pauseEndsAt}
        pause={pauseInfo.pause}
        maxPauses={pauseInfo.maxPauses}
        waitingFor={pauseInfo.waitingFor}
        onLeave={() => setAskingToLeave(true)}
      />
      <LeaveGameConfirm
        visible={askingToLeave && !finalScore}
        onConfirm={leaveForGood}
        onCancel={() => setAskingToLeave(false)}
      />
      <GalleryAccessModal
        access={finalScore || showWinner ? null : galleryGuard.blocked}
        onAllow={() => galleryGuard.check({ ask: true })}
        onSelectPhotos={galleryGuard.selectMore}
        onRetry={() => galleryGuard.check({ ask: false })}
        // It covers the game's Exit: its own way out asks the same question (EXP-377)
        onBack={() => setAskingToLeave(true)}
        backLabel={t.leaveGame}
        blocking
      />

      {/* Subtle indicator while socket.io reconnects; the game screen stays */}
      {!connected && !finalScore && (
        <View
          testID={TEST_IDS.reconnectingBanner}
          style={[tw`absolute z-100 items-center`, safeTopRow(insets, RECONNECTING_BANNER.top, RECONNECTING_BANNER.margin)]}
          pointerEvents="none"
        >
          <Text style={tw`text-white text-sm bg-gray-800 bg-opacity-80 px-3 py-1 rounded-full`}>{t.reconnecting}</Text>
        </View>
      )}

      <View style={tw`flex-1 bg-black`}>
        {/* Emoji reactions over the photo: own lane between the progress bar and the answer buttons, with its own
            state and listener (a reaction never re-renders this screen), mounted for the whole game. First child:
            the emoji picker (same zIndex) stays drawn above it */}
        <RoomReactionLane
          socket={socket}
          listening={!finalScore}
          photo={photo}
          latestPhoto={latestPhoto}
          top={progressBarAreaBottom(insets)}
          answersTop={answersTop}
          screenshotLabel={t.tookScreenshot}
        />

        {phase === "waiting-photo" ? (
          <View testID={TEST_IDS.gameWaitingPhoto} style={tw`flex-1 justify-center items-center px-6`}>
            {round > 0 && totalRounds > 0 && (
              <Text style={tw`text-gray-400 text-base mb-2`}>
                {t.roundOf.replace("{round}", String(round)).replace("{total}", String(totalRounds))}
              </Text>
            )}
            <Text testID={TEST_IDS.waitingPhotoText} style={tw`text-xl text-white font-bold text-center mb-6`}>
              {t.someoneChoosingPhoto}
            </Text>
            {phaseDuration > 0 && pauseEndsAt === null && (
              <View style={tw`w-full max-w-[500px]`}>
                <ProgressBar
                  key={phaseKey} duration={phaseDuration} elapsed={phaseBarElapsed} startedAt={phaseStartedAt}
                />
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

            {/* Held marker for the device flows (qa/maestro/play-rounds.yaml): invisible and untouchable; kept out of
                view flattening so it reaches the native view tree */}
            {gameHeld && (
              <View testID={TEST_IDS.gameHeld} style={tw`absolute inset-0`} pointerEvents="none" collapsable={false} />
            )}

            {/* Game overlay — hidden during hold so photo is visible */}
            {!gameHeld && (
              <View style={tw`z-8 absolute w-full h-full`}>
                {/* Progress bar during answering or scores */}
                {(phase === "answering" || phase === "scores") && phaseDuration > 0 && pauseEndsAt === null && (
                  <View
                    testID={TEST_IDS.roundProgress}
                    style={[
                      tw`absolute p-4 items-center`,
                      progressRow,
                      { height: PROGRESS_BAR_AREA.height },
                    ]}
                  >
                    <View style={tw`w-full max-w-[500px]`}>
                      <ProgressBar
                        key={phaseKey}
                        duration={phaseDuration}
                        elapsed={phaseBarElapsed}
                        startedAt={phaseStartedAt}
                        onEnd={phase === "answering" ? closeAnswers : undefined}
                      />
                    </View>
                  </View>
                )}

                {/* Player selection buttons: everyone's, the photo owner's too (they aren't told it's theirs) */}
                {showAnswers && (
                  <View
                    style={[tw`absolute z-40 p-2 flex-row justify-center`, safeBottomRow(insets, ANSWERS_BOTTOM)]}
                    onLayout={onAnswersLayout}
                  >
                    <AnswerOptionsGrid players={answerPlayers} layout={answersLayout} renderOption={renderAnswerOption} />
                  </View>
                )}

                {/* Score modal */}
                <ScoreModal
                  visible={phase === "scores" && !!scores}
                  scoreRound={scores ?? NO_SCORES}
                  rounds={scoreRounds}
                  correctAnswer={correctAnswer}
                  myUsername={safeUsername}
                  reserveHoldButton={holdButtonMounted}
                />
              </View>
            )}

            {/* Hold button — mounted during scores for photo owner, invisible while pressing, greyed out once no hold can start */}
            {holdButtonMounted && (
              <View
                style={[
                  tw`absolute z-60 items-center ${pressing ? "opacity-0" : ""}`,
                  safeBottomRow(insets, HOLD_BUTTON_BOTTOM),
                ]}
              >
                {/* `disabled` only refuses new presses: one already down when the holds end still gets its
                    onPressOut (React Native's Pressability), so its release is sent */}
                <TouchableOpacity
                  testID={TEST_IDS.holdButton}
                  style={tw`${noHoldsLeft ? "bg-gray-600 border-gray-400" : "bg-blue-600 border-blue-400"} p-4 rounded-xl w-[90%] max-w-[500px] border-2 shadow-lg items-center`}
                  onPressIn={onHoldPress}
                  onPressOut={onHoldRelease}
                  activeOpacity={0.8}
                  disabled={noHoldsLeft}
                >
                  <Text style={tw`text-white text-lg font-bold`}>{noHoldsLeft ? t.noHoldsLeft : t.holdPhoto}</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Not needed for the photo's first frame: mounted right after it */}
            <DeferredMount>
              <EmojisButton />
            </DeferredMount>
          </>
        ) : awaitingSnapshot ? (
          <View
            testID={TEST_IDS.gameLoading}
            style={tw`flex-1 justify-center items-center`}
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={t.loadingGame}
          >
            <ActivityIndicator size="large" color="white" />
          </View>
        ) : (
          <View testID={TEST_IDS.gameWaitingReady} style={tw`flex-1 justify-center items-center px-6`}>
            <ActivityIndicator size="large" color="white" />
            <Text style={tw`text-xl text-white font-bold text-center mt-4`}>{t.waitingEveryoneReady}</Text>
          </View>
        )}
      </View>

      {/* Exit: the pause modal has its own, and the photo stays clear while held */}
      {!finalScore && pauseEndsAt === null && !gameHeld && <LeaveGameButton onPress={() => setAskingToLeave(true)} />}
    </View>
  );
};

export default GameScreen;
