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
import { RoomOfGameResponse, Player } from "@/app/models/interfaces";
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
import { Ionicons } from "@expo/vector-icons";
import ChatMessage from "@/app/components/IngameComunication/ChatMessage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import SuccessAlert from "@/app/components/SuccessAlert";
import { LinearGradient } from "expo-linear-gradient";
import { useI18n } from "../i18n";

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
    setPlantedPhotoUri,
  } = useGameContext();
  const [players, setPlayers] = useState<Player[]>([]);
  const { backgroundImage } = useBackgroundContext();
  const [dialogVisible, setDialogVisible] = useState<boolean>(false);
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const [showCopyMessage, setShowCopyMessage] = useState<boolean>(false);
  const [hasPlantedPhoto, setHasPlantedPhoto] = useState<boolean>(false);
  const { requestGalleryPermission } = usePhotoContext();
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
        allowsEditing: true,
        quality: 0.8,
      });

      setIsSelecting(false);

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const selectedImage = result.assets[0].uri;

        // Store the URI in context instead of uploading immediately
        setPlantedPhotoUri(selectedImage);

        // Mark that the user has selected a photo to plant
        setHasPlantedPhoto(true);
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

  // Start socket once on mount
  useEffect(() => {
    startSocket();
  }, []);

  // Single effect: setup listeners, join room, handle reconnect
  useEffect(() => {
    if (!socket || !username) return;

    const doJoin = () => {
      const code = gameCodeRef.current;
      console.log("Joining room:", code);
      setIsLoading(true);
      socket.emit("join-create-game", { gameCode: code, username });
    };

    // Remove all previous listeners to avoid duplicates
    socket.removeAllListeners();

    socket.on("connect", () => {
      console.log("Socket connected");
      doJoin();
    });

    socket.on("room-of-game", (data: RoomOfGameResponse) => {
      console.log("Room data:", data);
      setIsLoading(false);
      if (!data.success) {
        endSocket();
        navigation.replace({ pathname: "/", params: { message: data.message } });
      } else if (data.room) {
        joinedRef.current = true;
        setPlayers(data.room.players);
        setGameCode(data.room.gameCode);
        setRoundsOfGame(data.room.rounds);
        const me = data.room.players.find((p) => p.username === username);
        if (me?.hasPlantedPhoto) setHasPlantedPhoto(true);
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
    socket.on("new-host", (h: Player) => setPlayers((prev) => prev.map((p) => ({ ...p, isHost: p.username === h.username }))));

    socket.on("game-started", (players: Player[]) => {
      setPlayersProvider(players);
      navigation.replace("/screens/GameScreen");
    });

    socket.on("player-removed", (removed: Player) => {
      if (removed.username === username) {
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
    };
  }, [socket, username]);

  const handleLeaveGame = () => {
    if (socket) socket.emit("leave-room");
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

  const handleRemovePlayer = (socketId: string) => {
    if (socket) {
      socket.emit("remove-player", { gameCode, socketId });
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
    return (
      <TouchableOpacity
        onPress={() => {
          if (players[0].username === username && !isMe) confirmRemovePlayer(item);
        }}
        activeOpacity={isMe || !isHost ? 1 : 0.7}
        style={[
          tw`flex-row items-center px-4 py-3 mb-2 rounded-2xl`,
          {
            backgroundColor: isMe ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.45)",
            borderWidth: 1,
            borderColor: isMe ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.12)",
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
        {isMe && <Text style={tw`text-white/40 text-xs`}>You</Text>}
      </TouchableOpacity>
    );
  };

  const isHost = players.length > 0 && players[0].username === username;

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
                <TouchableOpacity onPress={copyGameCodeToClipboard} style={tw`p-2`}>
                  <Ionicons name="copy-outline" size={24} color="rgba(255,255,255,0.7)" />
                </TouchableOpacity>
                <Text
                  style={[
                    tw`text-5xl text-white font-extrabold mx-1`,
                    { lineHeight: 60, textShadowColor: "rgba(0, 0, 0, 0.5)", textShadowOffset: { width: 2, height: 2 }, textShadowRadius: 5 },
                  ]}
                >
                  {gameCode}
                </Text>
                <TouchableOpacity onPress={shareGameCode} style={tw`p-2`}>
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

              <TouchableOpacity onPress={pickAndPlantImage} style={tw`mb-2 items-center`} disabled={isSelecting}>
                <View
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
              keyExtractor={(item) => item.socketId}
              style={tw`w-full flex-1`}
              contentContainerStyle={tw`pb-2`}
            />

            {/* Bottom controls section */}
            <View style={tw`w-full mt-2 mb-4`}>
              {players.length > 0 && players[0].username == username && players.length >= 2 ? (
                <>
                  {/* Round selector — pill style */}
                  <View style={[tw`flex-row justify-center mb-3 rounded-full p-1`, { backgroundColor: "rgba(255,255,255,0.08)" }]}>
                    {roundOptions.map((rounds) => (
                      <TouchableOpacity
                        key={rounds}
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
                  <View style={tw`flex flex-row justify-center opacity-70 items-center mb-4`}>
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
                value={chatMessage}
                onChangeText={setChatMessage}
                placeholder={t.typeMessage}
                placeholderTextColor="#999"
                style={tw`flex-1 bg-gray-800/90 text-white px-4 py-3 rounded-full mr-2`}
                maxLength={100}
              />
              <TouchableOpacity
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
            handleRemovePlayer(selectedPlayer.socketId);
          }
          setDialogVisible(false);
        }}
        onCancel={() => setDialogVisible(false)}
        confirmButtonColor="bg-red-600"
        cancelButtonColor="bg-blue-500"
      />
    </View>
  );
};

export default WaitingRoom;
