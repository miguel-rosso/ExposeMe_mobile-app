import React, { useEffect, useState, useCallback, useRef } from "react";
import { View, Text, TouchableOpacity, StatusBar, FlatList, BackHandler, AppState } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import tw from "twrnc";
import { useGameContext } from "../providers/GameContext";
import { Player, ScoreRound } from "../models/interfaces";
import { usePhotoContext } from "../providers/PhotoContext";
import { useRouter } from "expo-router";
import getEnvVars from "@/config";
import PhotoComponent from "@/app/components/PhotoComponent";
import ScoreModal from "@/app/components/modals/ScoreModal";
import ProgressBar from "@/app/components/ProgressBar";
import FinalScoreModal from "@/app/components/modals/FinalScoreModal";
import WinnerModal from "@/app/components/modals/WinnerModal";
import EmojiReaction from "@/app/components/IngameComunication/EmojiReaction";
import EmojisButton from "@/app/components/IngameComunication/EmojisButtons";
import { useI18n } from "../i18n";

const { SERVER_URL } = getEnvVars();

interface EmojiReactionData { id: string; username: string; emoji: string }
type Phase = "answering" | "reveal" | "scores" | null;

const GameScreen = () => {
  const { t } = useI18n();
  const { username, gameCode, endSocket, socket, playersProvider, roundsOfGame, plantedPhotoUri, uploadPlantedPhoto } =
    useGameContext();
  const safeUsername = username ?? "";
  const safeGameCode = gameCode ?? "";
  const { getRandomPhoto, setPhotoUri } = usePhotoContext();
  const router = useRouter();

  // ── Round state (reset each round) ───────────────────
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoOwner, setPhotoOwner] = useState("");
  const [round, setRound] = useState(0);
  const [phase, setPhase] = useState<Phase>(null);
  const [phaseDuration, setPhaseDuration] = useState(0);
  const [phaseKey, setPhaseKey] = useState(0);
  const [correctAnswer, setCorrectAnswer] = useState("");
  const [scores, setScores] = useState<ScoreRound[] | null>(null);
  const [mySelection, _setMySelection] = useState("");
  const mySelectionRef = useRef("");
  const setMySelection = (val: string) => { mySelectionRef.current = val; _setMySelection(val); };

  // ── Hold state ───────────────────────────────────────
  const [gameHeld, setGameHeld] = useState(false);  // server says game paused
  const [pressing, setPressing] = useState(false);   // my finger is on button

  // ── End game ─────────────────────────────────────────
  const [finalScore, setFinalScore] = useState<ScoreRound[] | null>(null);
  const [showFinalScore, setShowFinalScore] = useState(false);
  const [showWinner, setShowWinner] = useState(false);
  const [winner, setWinner] = useState<ScoreRound | null>(null);

  // ── Other ────────────────────────────────────────────
  const [emojiReactions, setEmojiReactions] = useState<EmojiReactionData[]>([]);
  const [plantedPhotoUploaded, setPlantedPhotoUploaded] = useState(false);
  const [isReady, setIsReady] = useState(false);

  // ── Derived ──────────────────────────────────────────
  const isOwner = username === photoOwner;
  // Hold button: mounted during scores phase for photo owner (or while pressing to catch onPressOut)
  const holdButtonMounted = isOwner && (phase === "scores" || pressing);

  // ── Upload helper ────────────────────────────────────
  const uploadImage = async (uri: string): Promise<string> => {
    const formData = new FormData();
    formData.append("image", { uri, name: "photo.jpg", type: "image/jpeg" } as any);
    const response = await fetch(`${SERVER_URL}/upload`, { method: "POST", body: formData });
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
    return (await response.json()).url;
  };

  // ── Block back button ────────────────────────────────
  useFocusEffect(useCallback(() => {
    const h = () => true;
    BackHandler.addEventListener("hardwareBackPress", h);
    return () => BackHandler.removeEventListener("hardwareBackPress", h);
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

  // ── Disconnect detection: go back to menu ────────────
  useEffect(() => {
    if (!socket) return;

    const onDisconnect = () => {
      console.log("[GAME] Socket disconnected — returning to menu");
      router.replace("/");
    };

    socket.on("disconnect", onDisconnect);

    // Also check when app comes back from background
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && !socket.connected) {
        onDisconnect();
      }
    });

    return () => {
      socket.off("disconnect", onDisconnect);
      sub.remove();
    };
  }, [socket]);

  // ── Socket listeners ─────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    // My turn: pick photo → upload → send
    socket.on("your-turn", async (data: { round: number }) => {
      setRound(data.round);
      try {
        const uri = await getRandomPhoto();
        if (!uri) { console.error("No photo selected"); return; }
        for (let i = 1; i <= 3; i++) {
          try {
            console.log(`Upload attempt ${i}...`);
            const url = await uploadImage(uri);
            console.log("Photo uploaded");
            socket.emit("photo-sent", { photo: url });
            setPhotoUri(null);
            return;
          } catch (e) {
            console.error(`Attempt ${i} failed:`, e);
            if (i < 3) await new Promise((r) => setTimeout(r, 1000 * i));
          }
        }
        console.error("All upload attempts failed");
      } catch (e) { console.error("your-turn error:", e); }
    });

    // Atomic: new round — photo + answer timer
    socket.on("round-start", (data: { photo: string; owner: string; round: number; duration: number }) => {
      console.log(`[GAME] round-start: round=${data.round}, owner=${data.owner}`);
      setPhoto(`${SERVER_URL}${data.photo}`);
      setPhotoOwner(data.owner);
      setRound(data.round);
      setPhase("answering");
      setPhaseDuration(data.duration);
      setPhaseKey((k) => k + 1);
      setCorrectAnswer("");
      setScores(null);
      setMySelection("");
      setAnswerSent(false);
      setGameHeld(false);
      setPressing(false);
    });

    // Atomic: answer revealed — submit answer NOW using ref (always current)
    socket.on("round-reveal", (data: { correctAnswer: string; duration: number }) => {
      console.log(`[GAME] round-reveal: ${data.correctAnswer}, my guess: ${mySelectionRef.current}`);
      socket.emit("submit-answer", { guess: mySelectionRef.current || "" });
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

    socket.on("round-skipped", () => { console.log("[GAME] round-skipped"); });

    socket.on("game-over", (data: { finalScore: ScoreRound[] }) => {
      console.log("[GAME] game-over");
      setFinalScore(data.finalScore);
      if (data.finalScore?.length > 0) { setWinner(data.finalScore[0]); setShowWinner(true); }
    });

    socket.on("emoji-reaction", (data: { username: string; emoji: string }) => {
      setEmojiReactions((c) => [...c, { id: `${Date.now()}-${Math.random()}`, ...data }]);
    });

    setIsReady(true);

    return () => {
      socket.off("your-turn"); socket.off("round-start"); socket.off("round-reveal");
      socket.off("round-scores"); socket.off("hold-start"); socket.off("hold-end");
      socket.off("hold-resume"); socket.off("round-skipped"); socket.off("game-over");
      socket.off("emoji-reaction");
      endSocket();
    };
  }, [socket]);

  // Upload planted photo first, THEN signal ready
  useEffect(() => {
    if (!isReady || !socket) return;

    const ready = async () => {
      // Upload planted photo before signaling ready
      if (plantedPhotoUri && !plantedPhotoUploaded) {
        try {
          console.log("Uploading planted photo before ready...");
          const url = await uploadPlantedPhoto();
          if (url) {
            socket.emit("plant-photo", { gameCode, username, photoUrl: url });
            setPlantedPhotoUploaded(true);
            console.log("Planted photo uploaded");
          }
        } catch (e) {
          console.error("Planted photo upload failed:", e);
        }
      }

      console.log("Emitting im-ready");
      socket.emit("im-ready", { gameCode: safeGameCode, username: safeUsername });
    };

    ready();
  }, [isReady]);

  const handleWinnerEnd = () => { setShowWinner(false); setShowFinalScore(true); };
  const removeEmoji = (id: string) => setEmojiReactions((c) => c.filter((r) => r.id !== id));

  // ── Render helpers ───────────────────────────────────
  const isRevealOrScores = phase === "reveal" || phase === "scores";

  const renderPlayer = ({ item }: { item: Player }) => {
    const isAnswer = item.username === photoOwner;
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
        style={tw`p-3 rounded-lg mb-2 mx-1 flex-grow flex-basis-[48%] ${bg}`}
        onPress={() => !isRevealOrScores && setMySelection(item.username)}
        disabled={isRevealOrScores}
      >
        <View style={tw`flex-row items-center justify-between`}>
          <Text style={tw`text-white text-base flex-1 ${isMe ? "font-bold" : ""}`} numberOfLines={1} ellipsizeMode="tail">
            {item.username}
          </Text>
          <View style={tw`flex-row items-center`}>
            {isMe && <Text style={tw`text-white text-xs bg-gray-600 px-1 py-0.5 rounded-full ml-1`}>You</Text>}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  // ── Main render ──────────────────────────────────────
  return (
    <View style={{ flex: 1 }}>
      <StatusBar hidden />
      <WinnerModal visible={showWinner} winner={winner} onAnimationEnd={handleWinnerEnd} />
      <FinalScoreModal visible={showFinalScore} finalScore={finalScore || []} />

      <View style={tw`flex-1 bg-black`}>
        {photo ? (
          <>
            <PhotoComponent photoUrl={photo} />

            {/* Emoji reactions */}
            <View style={tw`absolute top-4 left-4 z-90`}>
              {emojiReactions.map((r) => (
                <EmojiReaction key={r.id} username={r.username} emoji={r.emoji} onAnimationEnd={() => removeEmoji(r.id)} />
              ))}
            </View>

            {/* Game overlay — hidden during hold so photo is visible */}
            {!gameHeld && (
              <View style={tw`z-8 absolute w-full h-full`}>
                {/* Progress bar during answering or scores */}
                {(phase === "answering" || phase === "scores") && phaseDuration > 0 && (
                  <View style={tw`absolute top-15 left-0 right-0 p-4 items-center`}>
                    <View style={tw`w-full max-w-[500px]`}>
                      <ProgressBar key={phaseKey} duration={phaseDuration} />
                    </View>
                  </View>
                )}

                {/* Player selection buttons */}
                <View style={tw`absolute z-40 bottom-22 left-0 right-0 p-2 flex-row justify-center`}>
                  <FlatList
                    data={playersProvider}
                    renderItem={renderPlayer}
                    keyExtractor={(item) => item.socketId}
                    numColumns={2}
                    columnWrapperStyle={tw`justify-between`}
                    style={tw`w-full max-w-[500px] px-2`}
                    contentContainerStyle={tw`w-full`}
                  />
                </View>

                {/* Score modal */}
                <ScoreModal
                  visible={phase === "scores" && !!scores}
                  scoreRound={scores || []}
                  rounds={{ round, roundsOfGame: roundsOfGame }}
                  correctAnswer={correctAnswer}
                />
              </View>
            )}

            {/* Hold button — mounted during scores for photo owner, invisible while pressing */}
            {holdButtonMounted && (
              <View style={tw`absolute bottom-24 left-0 right-0 z-60 items-center ${pressing ? "opacity-0" : ""}`}>
                <TouchableOpacity
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
          <View style={tw`flex-1 justify-center items-center`}>
            <Text style={tw`text-xl text-white font-bold mb-4`}>{t.areYouReady}</Text>
          </View>
        )}
      </View>
    </View>
  );
};

export default GameScreen;
