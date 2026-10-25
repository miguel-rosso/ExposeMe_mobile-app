import React, { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  FlatList,
  StatusBar,
  TouchableOpacity,
  Alert,
  TextInput,
  Keyboard,
  Platform,
  Animated,
  Share,
} from "react-native";
import tw from "twrnc";
import { useGameContext } from "@/app/providers/GameContext";
import { useRouter, useLocalSearchParams } from "expo-router";
import { RoomOfGameResponse, Player, GameStateSnapshot, PlayerConnectionData } from "@/app/models/interfaces";
import ImageBlur from "@/app/components/ImageBlur/ImageBlur";
import { ImageBlurView } from "@/app/components/ImageBlur";
import { useBackgroundContext } from "@/app/providers/BackgroundContext";
import { usePhotoContext } from "@/app/providers/PhotoContext";
import CloseButton from "@/app/components/CloseButton";
import Icon from "react-native-vector-icons/FontAwesome";
import AnimatedDot from "@/app/components/AnimatedDot";
import * as Animatable from "react-native-animatable";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import AlertModal from "@/app/components/modals/AlertModal";
import GalleryAccessModal from "@/app/components/modals/GalleryAccessModal";
import { useGalleryAccessGuard } from "@/app/hooks/useGalleryAccessGuard";
import { Ionicons } from "@expo/vector-icons";
import ChatMessage from "@/app/components/IngameComunication/ChatMessage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import SuccessAlert from "@/app/components/SuccessAlert";
import { LinearGradient } from "expo-linear-gradient";
import { useI18n } from "../i18n";
import { TEST_IDS, lobbyPlayerId, lobbyPlayerOfflineId, roundsOptionId } from "../utils/testIds";
import { isHostIn, withConnection, withHost } from "../utils/roomPlayers";

// Define chat message interface
interface ChatMessageType {
  id: string;
  username: string;
  message: string;
}

const WaitingRoom = ({}) => {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const navigation = useRouter();
  const { code: deepLinkCode } = useLocalSearchParams<{ code?: string }>();
  const {
    startSocket,
    endSocket,
    gameCode,
    setGameCode,
    setPlayersProvider,
    socket,
    username,
    setRoundsOfGame,
    roundsOfGame,
    plantedPhotoUri,
    setPlantedPhotoUri,
    plantPhoto,
    saveRejoinToken,
    getRejoinToken,
    clearRejoinToken,
  } = useGameContext();
  const [players, setPlayers] = useState<Player[]>([]);
  const { backgroundImage } = useBackgroundContext();
  const [dialogVisible, setDialogVisible] = useState<boolean>(false);
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const [showCopyMessage, setShowCopyMessage] = useState<boolean>(false);
  // Planted: a photo picked on this device for this game, or the server already has mine (its own mark, only told
  // to me in room-of-game: e.g. after reopening the app in the lobby)
  const [serverPlanted, setServerPlanted] = useState<boolean>(false);
  const hasPlantedPhoto = !!plantedPhotoUri || serverPlanted;
  const plantedUriRef = useRef(plantedPhotoUri);
  useEffect(() => { plantedUriRef.current = plantedPhotoUri; }, [plantedPhotoUri]);
  const { requestGalleryPermission } = usePhotoContext();
  const galleryGuard = useGalleryAccessGuard({ watch: true });
  const [showPhotoAddedMessage, setShowPhotoAddedMessage] = useState<boolean>(false);
  const [isSelecting, setIsSelecting] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true); // New loading state

  // New state for chat functionality
  const [chatMessage, setChatMessage] = useState<string>("");
  const [chatMessages, setChatMessages] = useState<ChatMessageType[]>([]);
  const [lastSentTime, setLastSentTime] = useState<number>(0);
  const COOLDOWN_TIME = 1000; // 1 second cooldown between messages

  const roundOptions = [10, 15, 20];

  // Keyboard height animation — the professional way
  const keyboardPadding = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showListener = Keyboard.addListener(showEvent, (e) => {

      if (Platform.OS === "ios") {
        Animated.timing(keyboardPadding, {
          toValue: e.endCoordinates.height,
          duration: 250,
          useNativeDriver: false,
        }).start();
      } else {
        keyboardPadding.setValue(e.endCoordinates.height);
      }
    });

    const hideListener = Keyboard.addListener(hideEvent, () => {

      if (Platform.OS === "ios") {
        Animated.timing(keyboardPadding, {
          toValue: 0,
          duration: 200,
          useNativeDriver: false,
        }).start();
      } else {
        keyboardPadding.setValue(0);
      }
    });

    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, []);

  const removeChatMessage = (id: string) => {
    setChatMessages((prevMessages) => prevMessages.filter((msg) => msg.id !== id));
  };

  const sendChatMessage = () => {
    if (!chatMessage.trim()) return;
    const currentTime = Date.now();

    // Check cooldown
    if (currentTime - lastSentTime >= COOLDOWN_TIME) {
      if (socket && gameCode) {
        socket.emit("chat-message", {
          gameCode,
          username,
          message: chatMessage.trim(),
        });

        // Add message locally for the sender
        const messageId = `${Date.now()}-${Math.random()}`;
        setChatMessages((prev) => [
          ...prev,
          {
            id: messageId,
            username: username || "You",
            message: chatMessage.trim(),
          },
        ]);

        setChatMessage("");
        setLastSentTime(currentTime);
        Keyboard.dismiss();
      }
    } else {
      Alert.alert(t.slowDown, t.pleaseWaitBeforeSending);
    }
  };

  const pickAndPlantImage = async () => {
    if (!hasPlantedPhoto) {
      // First-time photo selection
      Alert.alert(t.plantSecretPhoto, t.choosePhotoDescription, [
        { text: t.cancel, style: "cancel" },
        { text: t.choosePhoto, onPress: async () => await selectImageFromGallery() },
      ]);
    } else {
      // Allow changing the already planted photo
      Alert.alert(t.photoAlreadyPlanted, t.changePhotoQuestion, [
        { text: t.keepCurrentPhoto, style: "cancel" },
        { text: t.changePhoto, onPress: async () => await selectImageFromGallery() },
      ]);
    }
  };

  const selectImageFromGallery = async () => {
    const hasPermission = await requestGalleryPermission({ askAgain: true });

    if (!hasPermission) {
      Alert.alert(t.permissionRequired, t.needPhotoAccess);
      return;
    }

    setIsSelecting(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: "images",
        // No crop: a square planted photo would stand out among the game's uncropped gallery photos
        allowsEditing: false,
        quality: 0.8,
      });

      setIsSelecting(false);

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const selectedImage = result.assets[0].uri;

        // Upload and plant it now, in the lobby: im-ready must never wait for it (if this fails, the game screen
        // retries after im-ready)
        setPlantedPhotoUri(selectedImage);
        plantedUriRef.current = selectedImage;
        plantPhoto();
        setShowPhotoAddedMessage(true);
        setTimeout(() => {
          setShowPhotoAddedMessage(false);
        }, 2000);
      }
    } catch (error) {
      setIsSelecting(false);
      Alert.alert(t.error, t.errorSelectingImage);
    }
  };

  // If opened via deep link, set the game code
  useEffect(() => {
    if (deepLinkCode && !gameCode) {
      console.log("Deep link code:", deepLinkCode);
      setGameCode(deepLinkCode);
    }
  }, [deepLinkCode]);

  // Ref always holds current gameCode (avoids stale closures)
  const gameCodeRef = useRef(gameCode);
  useEffect(() => { gameCodeRef.current = gameCode; }, [gameCode]);
  const joinedRef = useRef(false);
  // Our binding from the last room-of-game (code + rejoin token), to ask for the game state again
  const bindingRef = useRef<{ gameCode: string; rejoinToken?: string } | null>(null);
  // Set when we enter a game that was already running (rejoin via "Join" after closing the app)
  const resyncOnLeaveRef = useRef(false);

  // Start socket once on mount
  useEffect(() => {
    startSocket();
  }, []);

  // Single effect: setup listeners, join room, handle reconnect
  useEffect(() => {
    if (!socket || !username) return;

    const doJoin = async () => {
      const code = gameCodeRef.current;
      console.log("Joining room:", code);
      setIsLoading(true);
      const rejoinToken = code ? await getRejoinToken(code, username) : null;
      socket.emit("join-create-game", { gameCode: code, username, ...(rejoinToken ? { rejoinToken } : {}) });
    };

    // Remove all previous listeners to avoid duplicates
    socket.removeAllListeners();

    socket.on("connect", () => {
      console.log("Socket connected");
      doJoin();
    });

    socket.on("room-of-game", (data: RoomOfGameResponse) => {
      const { rejoinToken: _token, ...loggable } = data;
      console.log("Room data:", loggable);
      setIsLoading(false);
      if (!data.success) {
        endSocket();
        navigation.replace({ pathname: "/", params: { message: data.message } });
      } else if (data.room) {
        joinedRef.current = true;
        bindingRef.current = { gameCode: data.room.gameCode, rejoinToken: data.rejoinToken };
        if (data.rejoinToken) saveRejoinToken(data.room.gameCode, username, data.rejoinToken);
        setPlayers(data.room.players);
        setGameCode(data.room.gameCode);
        setRoundsOfGame(data.room.rounds);
        // Lobby only (a rejoin into a started game leaves the planted photo alone): show the server's own mark, and
        // plant the picked photo again if the server doesn't have it (upload failed, or lost on a new socket)
        if (!data.room.started) {
          setServerPlanted(!!data.hasPlantedPhoto);
          if (!data.hasPlantedPhoto && plantedUriRef.current) plantPhoto();
        }
      }
    });

    socket.on("chat-message", (data: { username: string; message: string }) => {
      if (data.username !== username) {
        setChatMessages((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, username: data.username, message: data.message }]);
      }
    });

    socket.on("rounds-updated", (rounds: number) => setRoundsOfGame(rounds));
    socket.on("player-joined", (p: Player) => setPlayers((prev) => [...prev, p]));
    socket.on("player-left", (name: string) => setPlayers((prev) => prev.filter((p) => p.username !== name)));
    socket.on("new-host", (h: Player) => setPlayers((prev) => withHost(prev, h.username)));
    socket.on("player-connection", (d: PlayerConnectionData) => setPlayers((prev) => withConnection(prev, d.username, d.connected)));

    socket.on("game-started", (players: Player[]) => {
      setPlayersProvider(players);
      navigation.replace("/screens/GameScreen");
    });

    // Every rejoin is followed by a snapshot; a started game means we came back to a game in progress
    // (e.g. "Join" after closing the app): go straight to the game screen
    socket.on("game-state", (snap: GameStateSnapshot) => {
      if (!snap.started || resyncOnLeaveRef.current) return;
      resyncOnLeaveRef.current = true;
      setPlayersProvider(snap.players);
      setRoundsOfGame(snap.totalRounds);
      navigation.replace("/screens/GameScreen");
    });

    socket.on("player-removed", (removed: Player) => {
      if (removed.username === username) {
        clearRejoinToken();
        endSocket();
        navigation.replace("/");
      } else {
        setPlayers((prev) => prev.filter((p) => p.username !== removed.username));
      }
    });

    // If already connected, join now
    if (socket.connected) doJoin();

    return () => {
      socket.removeAllListeners();
      // The snapshot (and a your-turn for an awaited photo) reached this screen, not the game screen. The game
      // screen's listeners are attached in this same commit, before any server reply can arrive, so ask again:
      // a join on the same socket answers with a fresh snapshot (and your-turn) for the game screen to render.
      const binding = bindingRef.current;
      if (resyncOnLeaveRef.current && binding) {
        resyncOnLeaveRef.current = false;
        socket.emit("join-create-game", {
          gameCode: binding.gameCode,
          username,
          ...(binding.rejoinToken ? { rejoinToken: binding.rejoinToken } : {}),
        });
      }
    };
  }, [socket, username]);

  const handleLeaveGame = () => {
    if (socket) socket.emit("leave-room");
    clearRejoinToken();
    endSocket();
    navigation.replace("/");
  };

  const handleStartGame = () => {
    if (socket) {
      socket.emit("start-game", { gameCode });
    }
  };

  const handleSetRounds = (rounds: number) => {
    setRoundsOfGame(rounds);
    if (socket) {
      socket.emit("set-rounds", { gameCode, rounds });
    }
  };

  const handleRemovePlayer = (target: string) => {
    if (socket) {
      socket.emit("remove-player", { gameCode, username: target });
    }
  };

  const confirmRemovePlayer = (player: Player) => {
    setSelectedPlayer(player);
    setDialogVisible(true);
  };

  const shareGameCode = async () => {
    if (!gameCode) return;
    try {
      await Share.share({
        message: t.shareMessage + `https://exposeme-mobile-app-f72q.onrender.com/join/${gameCode}`,
      });
    } catch (e) {
      // User cancelled share
    }
  };

  const copyGameCodeToClipboard = async () => {
    if (gameCode) {
      await Clipboard.setStringAsync(gameCode);
      setShowCopyMessage(true);
      setTimeout(() => {
        setShowCopyMessage(false);
      }, 2000);
    }
  };

  const renderPlayer = ({ item }: { item: Player }) => {
    const isMe = item.username === username;
    const offline = item.connected === false;
    return (
      <TouchableOpacity
        testID={lobbyPlayerId(item.username)}
        onPress={() => {
          if (isHost && !isMe) confirmRemovePlayer(item);
        }}
        activeOpacity={isMe || !isHost ? 1 : 0.7}
        style={[
          tw`flex-row items-center px-4 py-3 mb-2 rounded-2xl`,
          {
            backgroundColor: isMe ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.45)",
            borderWidth: 1,
            borderColor: isMe ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.12)",
            opacity: offline ? 0.5 : 1,
          },
        ]}
      >
        <View style={tw`h-9 w-9 rounded-full bg-white/10 items-center justify-center mr-3`}>
          {item.isHost ? (
            <Text style={tw`text-sm`}>👑</Text>
          ) : (
            <Text style={tw`text-white text-sm font-bold opacity-50`}>
              {item.username.charAt(0).toUpperCase()}
            </Text>
          )}
        </View>
        <Text style={tw`text-white text-base flex-1 ${isMe ? "font-bold" : "font-medium"}`}>
          {item.username}
        </Text>
        {offline && (
          <Text testID={lobbyPlayerOfflineId(item.username)} style={tw`text-white/60 text-xs italic mr-2`}>
            {t.playerDisconnected}
          </Text>
        )}
        {isMe && <Text style={tw`text-white/40 text-xs`}>{t.you}</Text>}
      </TouchableOpacity>
    );
  };

  const isHost = isHostIn(players, username);

  return (
    <View style={tw`flex-1`}>
      <View style={tw`absolute w-full h-full`}>
        <StatusBar hidden />
        {/* Background blur - unchanged */}
        <ImageBlur
          src={backgroundImage}
          blurRadius={10}
          blurChildren={<ImageBlurView style={{ height: "100%", width: "100%" }} />}
          style={{ flex: 1 }}
        />
      </View>
      <CloseButton onPress={handleLeaveGame} />

      {/* Chat messages container - unchanged */}
      <View style={tw`absolute top-20 left-0 right-0 z-40 items-center`}>
        {chatMessages.map((msg) => (
          <ChatMessage
            key={msg.id}
            username={msg.username}
            message={msg.message}
            onAnimationEnd={() => removeChatMessage(msg.id)}
          />
        ))}
      </View>

      {/* Loading overlay and notifications */}
      {isLoading && (
        <View style={tw`absolute top-0 left-0 right-0 bottom-0 z-50 flex justify-center items-center bg-black bg-opacity-50`}>
          <View style={tw`px-8 py-6 rounded-xl bg-gray-800 flex items-center`}>
            <Animatable.View animation="rotate" iterationCount="infinite" easing="linear" duration={1500}>
              <Icon name="spinner" size={40} color="white" />
            </Animatable.View>
            <Text style={tw`text-white mt-4 text-lg font-bold`}>{t.loadingGameRoom}</Text>
            <Text style={tw`text-white mt-2 text-sm opacity-70`}>{t.pleaseWait}</Text>
          </View>
        </View>
      )}

      {/* Copy notification overlay - centered on screen */}
      {showCopyMessage && <SuccessAlert text={t.gameCodeCopied} />}

      {/* Photo Added notification overlay */}
      {showPhotoAddedMessage && <SuccessAlert text={t.photoSelectedForGame} />}

      {/* Photo selection */}
      {isSelecting && (
        <View style={tw`absolute top-0 left-0 right-0 bottom-0 z-50 flex justify-center items-center bg-black bg-opacity-50`}>
          <View style={tw`px-8 py-6 rounded-xl bg-gray-800 flex items-center`}>
            <Animatable.View animation="rotate" iterationCount="infinite" easing="linear" duration={1500}>
              <Icon name="spinner" size={40} color="white" />
            </Animatable.View>
            <Text style={tw`text-white mt-4 text-lg font-bold`}>{t.selectingPhoto}</Text>
          </View>
        </View>
      )}

      {/* Main container */}
      <View style={tw`flex-1`}>
        <View style={tw`flex-1 flex `}>
          {/* Main content area */}
          <View style={tw`flex-1 pt-14 px-4 max-w-[500px] w-full self-center ${isLoading ? "opacity-0" : "opacity-100"}`}>
            <View style={tw`items-center mb-2`}>
              <Text
                style={[
                  tw`text-xl text-white font-bold mb-1`,
                  { textShadowColor: "rgba(0, 0, 0, 0.5)", textShadowOffset: { width: 2, height: 2 }, textShadowRadius: 4 },
                ]}
              >
                {t.gameCode}
              </Text>

              <View style={tw`flex-row items-center mb-1`}>
                <TouchableOpacity testID={TEST_IDS.copyCodeButton} onPress={copyGameCodeToClipboard} style={tw`p-2`}>
                  <Ionicons name="copy-outline" size={24} color="rgba(255,255,255,0.7)" />
                </TouchableOpacity>
                <Text
                  testID={TEST_IDS.lobbyGameCode}
                  style={[
                    tw`text-5xl text-white font-extrabold mx-1`,
                    { lineHeight: 60, textShadowColor: "rgba(0, 0, 0, 0.5)", textShadowOffset: { width: 2, height: 2 }, textShadowRadius: 5 },
                  ]}
                >
                  {gameCode}
                </Text>
                <TouchableOpacity testID={TEST_IDS.shareCodeButton} onPress={shareGameCode} style={tw`p-2`}>
                  <Ionicons name="share-social-outline" size={24} color="rgba(255,255,255,0.7)" />
                </TouchableOpacity>
              </View>

              <Text
                style={[
                  tw`text-white font-extrabold mb-2`,
                  { textShadowColor: "rgba(0, 0, 0, 0.5)", textShadowOffset: { width: 2, height: 2 }, textShadowRadius: 5 },
                ]}
              >
                {roundsOfGame} {t.rounds}
              </Text>

              <TouchableOpacity testID={TEST_IDS.plantPhotoButton} onPress={pickAndPlantImage} style={tw`mb-2 items-center`} disabled={isSelecting}>
                <View
                  testID={hasPlantedPhoto ? TEST_IDS.plantPhotoPlanted : TEST_IDS.plantPhotoNotPlanted}
                  style={tw`h-14 w-14 rounded-full ${hasPlantedPhoto ? "bg-green-600" : "bg-black/40"} flex justify-center items-center`}
                >
                  <Icon
                    name={hasPlantedPhoto ? "check" : "camera"}
                    size={22}
                    color="white"
                    style={hasPlantedPhoto ? tw`ml-0.5` : tw``}
                  />
                </View>
                <Text style={tw`mt-1 text-white font-medium text-center text-xs`}>
                  {hasPlantedPhoto ? t.photoPlanted : t.plantPhoto}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Player list with limited height */}
            <FlatList
              data={players}
              renderItem={renderPlayer}
              keyExtractor={(item) => item.username}
              style={tw`w-full flex-1`}
              contentContainerStyle={tw`pb-2`}
            />

            {/* Bottom controls section */}
            <View style={tw`w-full mt-2 mb-4`}>
              {isHost && players.length >= 2 ? (
                <>
                  {/* Round selector — pill style */}
                  <View style={[tw`flex-row justify-center mb-3 rounded-full p-1`, { backgroundColor: "rgba(255,255,255,0.08)" }]}>
                    {roundOptions.map((rounds) => (
                      <TouchableOpacity
                        key={rounds}
                        testID={roundsOptionId(rounds)}
                        onPress={() => handleSetRounds(rounds)}
                        style={[
                          tw`flex-1 py-2 rounded-full items-center`,
                          roundsOfGame === rounds
                            ? { backgroundColor: "#e9042e" }
                            : {},
                        ]}
                      >
                        <Text style={tw`text-white text-sm ${roundsOfGame === rounds ? "font-bold" : "opacity-60"}`}>
                          {rounds}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  {/* Start button */}
                  <TouchableOpacity
                    testID={TEST_IDS.startGameButton}
                    onPress={handleStartGame}
                    activeOpacity={0.8}
                    style={[
                      tw`w-full py-4 rounded-2xl items-center`,
                      { backgroundColor: "#e9042e" },
                    ]}
                  >
                    <Text style={tw`text-white font-bold text-lg`}>{t.startGame}</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <View style={tw`p-2 w-full flex flex-col justify-center items-center`}>
                  <View testID={TEST_IDS.lobbyWaiting} style={tw`flex flex-row justify-center opacity-70 items-center mb-4`}>
                    <Text style={tw`text-white`}>{players.length < 2 ? t.waitingForPlayers : t.waitingHost}</Text>
                    <View style={tw`flex-row`}>
                      <AnimatedDot delay={0} />
                      <AnimatedDot delay={200} />
                      <AnimatedDot delay={400} />
                    </View>
                  </View>

                  {/* Host explanation message */}
                  {isHost && players.length <= 1 && (
                    <Animatable.View animation="fadeIn">
                      <Text
                        style={[
                          tw`text-white text-center italic opacity-80 `,
                          {
                            textShadowColor: "rgba(0, 0, 0, 0.7)",
                            textShadowOffset: { width: 1, height: 1 },
                            textShadowRadius: 3,
                          },
                        ]}
                      >
                        {t.sendCodeToFriends}
                      </Text>
                    </Animatable.View>
                  )}
                </View>
              )}
            </View>
          </View>
          {/* Chat footer */}
          <Animated.View style={[tw`w-full mb-5`, { paddingBottom: keyboardPadding }]}>
            <View style={tw`px-2 py-2 flex-row items-center max-w-[500px] w-full self-center`}>
              <TextInput
                testID={TEST_IDS.chatInput}
                value={chatMessage}
                onChangeText={setChatMessage}
                placeholder={t.typeMessage}
                placeholderTextColor="#999"
                style={tw`flex-1 bg-gray-800/90 text-white px-4 py-3 rounded-full mr-2`}
                maxLength={100}
              />
              <TouchableOpacity
                testID={TEST_IDS.chatSendButton}
                onPress={sendChatMessage}
                disabled={!chatMessage.trim()}
                style={tw`rounded-full w-10 h-10 ${!chatMessage.trim() ? "bg-gray-600" : "bg-[#ff8605]"} items-center justify-center`}
              >
                <Ionicons name="send" size={20} color="white" />
              </TouchableOpacity>
            </View>
          </Animated.View>
        </View>
      </View>

      {/* Dialog modal - unchanged */}
      <AlertModal
        visible={dialogVisible}
        title={t.confirmRemovePlayer}
        message={t.areYouSureRemove}
        highlightedText={`@${selectedPlayer?.username}`}
        confirmText={t.remove}
        cancelText={t.cancel}
        onConfirm={() => {
          if (selectedPlayer) {
            handleRemovePlayer(selectedPlayer.username);
          }
          setDialogVisible(false);
        }}
        onCancel={() => setDialogVisible(false)}
        confirmButtonColor="bg-red-600"
        cancelButtonColor="bg-blue-500"
      />

      {/* No photo access / no photos (re-checked on foreground): can't stay in the lobby without them */}
      <GalleryAccessModal
        access={galleryGuard.blocked}
        onAllow={() => galleryGuard.check({ ask: true })}
        onSelectPhotos={galleryGuard.selectMore}
        onRetry={() => galleryGuard.check({ ask: false })}
        onBack={handleLeaveGame}
        blocking
      />
    </View>
  );
};

export default WaitingRoom;
