import React, { useCallback, useEffect, useState, useRef } from "react";
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
import { useFocusEffect } from "@react-navigation/native";
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

// Define chat message interface
interface ChatMessageType {
  id: string;
  username: string;
  message: string;
}

const WaitingRoom = ({}) => {
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
  const [isInGame, setIsInGame] = useState<boolean>(false);
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
      Alert.alert("Slow down", "Please wait before sending another message");
    }
  };

  const pickAndPlantImage = async () => {
    if (!hasPlantedPhoto) {
      // First-time photo selection
      Alert.alert("Plant a Secret Photo", "Choose a photo that will appear at a random moment in the game.", [
        { text: "Cancel", style: "cancel" },
        { text: "Choose Photo", onPress: async () => await selectImageFromGallery() },
      ]);
    } else {
      // Allow changing the already planted photo
      Alert.alert("Photo Already Planted", "Would you like to change your planted photo?", [
        { text: "Keep Current Photo", style: "cancel" },
        { text: "Change Photo", onPress: async () => await selectImageFromGallery() },
      ]);
    }
  };

  const selectImageFromGallery = async () => {
    const hasPermission = await requestGalleryPermission({ askAgain: true });

    if (!hasPermission) {
      Alert.alert("Permission Required", "We need access to your photos to plant an image in the game.");
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
      Alert.alert("Error", "There was an error selecting your image.");
    }
  };

  // If opened via deep link, set the game code
  useEffect(() => {
    if (deepLinkCode && !gameCode) {
      console.log("Deep link code:", deepLinkCode);
      setGameCode(deepLinkCode);
    }
  }, [deepLinkCode]);

  useFocusEffect(
    useCallback(() => {
      console.log("focus waiting room");

      if (!isInGame) {
        startSocket();
      }

      return () => {
        console.log("desfocus waiting room");
        socket?.off("room-of-game");
        socket?.off("player-joined");
        socket?.off("player-left");
        socket?.off("host-left");
        socket?.off("new-host");
        socket?.off("photo-planted");
      };
    }, [isInGame])
  );

  useEffect(() => {
    if (socket && username && !isInGame) {
      console.log("Joining game with code:", gameCode);
      setIsInGame(true);
      setIsLoading(true); // Start loading when joining
      // Limpiar listeners antes de agregar nuevos
      socket.off("room-of-game");
      socket.off("player-joined");
      socket.off("player-left");
      socket.off("host-left");
      socket.off("new-host");
      socket.off("photo-planted");
      socket.off("chat-message"); // Add this line

      socket.emit("join-create-game", { gameCode, username });

      // Add the new chat message listener
      socket.on("chat-message", (data: { username: string; message: string }) => {
        // Only add messages from others, we've already added our own
        if (data.username !== username) {
          const messageId = `${Date.now()}-${Math.random()}`;
          setChatMessages((prev) => [
            ...prev,
            {
              id: messageId,
              username: data.username,
              message: data.message,
            },
          ]);
        }
      });

      socket.on("room-of-game", (data: RoomOfGameResponse) => {
        console.log("Room data:", data);
        setIsLoading(false); // Room data received, stop loading
        if (!data.success) {
          console.log("Room not found:", data.message);
          endSocket();
          navigation.replace({ pathname: "/", params: { message: data.message } });
        } else {
          console.log("Room found:", data.room);
          if (data.room) {
            setPlayers(data.room.players);
            setGameCode(data.room.gameCode);
            setRoundsOfGame(data.room.rounds);

            // Check if current user has already marked a photo to plant
            const currentPlayer = data.room.players.find((p) => p.username === username);
            if (currentPlayer && currentPlayer.hasPlantedPhoto) {
              setHasPlantedPhoto(true);
            }
          }
        }
      });

      socket.on("rounds-updated", (rounds: number) => {
        setRoundsOfGame(rounds);
        console.log("Rounds updated:", rounds);
      });

      socket.on("player-joined", (newPlayer: Player) => {
        setPlayers((prevPlayers) => [...prevPlayers, newPlayer]);
      });

      socket.on("player-left", (username: string) => {
        setPlayers((prevPlayers) => prevPlayers.filter((player) => player.username !== username));
      });

      socket.on("new-host", (newHost: Player) => {
        setPlayers((prevPlayers) => {
          // Eliminar al host actual
          const filteredPlayers = prevPlayers.filter((player) => !player.isHost);
          // Definir el nuevo host
          return filteredPlayers.map((player) => (player.username === newHost.username ? { ...player, isHost: true } : player));
        });
      });

      socket.on("game-started", (players: Player[]) => {
        setPlayersProvider(players);
        console.log("Game started");
        navigation.replace("/screens/GameScreen");
      });

      socket.on("player-removed", (removedPlayer: Player) => {
        if (removedPlayer.username === username) {
          endSocket();
          navigation.replace("/");
        } else {
          setPlayers((prevPlayers) => prevPlayers.filter((player) => player.username !== removedPlayer.username));
        }
      });
    }
  }, [socket]);

  const handleLeaveGame = () => {
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
        message: `Join my ExposeMe game!\nhttps://exposeme-mobile-app-f72q.onrender.com/join/${gameCode}`,
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

  const renderPlayer = ({ item }: { item: Player }) => (
    <LinearGradient
      colors={["#fe5436", "#fe3a18", "#eb2200"]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      style={tw`rounded-2xl mb-4 w-full p-4 rounded-full mb-2`}
    >
      <TouchableOpacity
        onPress={() => {
          if (players[0].username === username && item.username !== username) {
            confirmRemovePlayer(item);
          }
        }}
        style={tw`relative   flex-row items-center`}
      >
        {/* Left side - host/user icon */}
        <View style={tw`absolute left-6 flex-row items-center`}>
          {item.isHost && <Text style={tw`mr-2 text-base`}>👑</Text>}
          {item.username === username && <Icon name="user" size={20} color="white" />}
        </View>

        {/* Center - username */}
        <Text style={tw`text-white text-lg mx-auto font-bold`}>{item.username}</Text>
      </TouchableOpacity>
    </LinearGradient>
  );

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
            <Text style={tw`text-white mt-4 text-lg font-bold`}>Loading game room...</Text>
            <Text style={tw`text-white mt-2 text-sm opacity-70`}>Please wait a moment</Text>
          </View>
        </View>
      )}

      {/* Copy notification overlay - centered on screen */}
      {showCopyMessage && <SuccessAlert text="Game code copied" />}

      {/* Photo Added notification overlay */}
      {showPhotoAddedMessage && <SuccessAlert text="Photo selected for the game!" />}

      {/* Photo selection */}
      {isSelecting && (
        <View style={tw`absolute top-0 left-0 right-0 bottom-0 z-50 flex justify-center items-center bg-black bg-opacity-50`}>
          <View style={tw`px-8 py-6 rounded-xl bg-gray-800 flex items-center`}>
            <Animatable.View animation="rotate" iterationCount="infinite" easing="linear" duration={1500}>
              <Icon name="spinner" size={40} color="white" />
            </Animatable.View>
            <Text style={tw`text-white mt-4 text-lg font-bold`}>Selecting your photo...</Text>
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
                Game Code
              </Text>

              <View style={tw`flex items-center mb-1 relative overflow-visible`}>
                <Text
                  style={[
                    tw`text-5xl text-white font-extrabold`,
                    { lineHeight: 60, textShadowColor: "rgba(0, 0, 0, 0.5)", textShadowOffset: { width: 2, height: 2 }, textShadowRadius: 5 },
                  ]}
                >
                  {gameCode}
                </Text>
                <View style={tw`absolute right-[-90px] flex-row`}>
                  <TouchableOpacity onPress={copyGameCodeToClipboard} style={tw`p-2`}>
                    <Ionicons name="copy-outline" size={26} color="white" />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={shareGameCode} style={tw`p-2`}>
                    <Ionicons name="share-social-outline" size={26} color="white" />
                  </TouchableOpacity>
                </View>
              </View>

              <Text
                style={[
                  tw`text-white font-extrabold mb-2`,
                  { textShadowColor: "rgba(0, 0, 0, 0.5)", textShadowOffset: { width: 2, height: 2 }, textShadowRadius: 5 },
                ]}
              >
                {roundsOfGame} Rounds
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
                  {hasPlantedPhoto ? "Photo Planted" : "Plant Photo"}
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
                  <View style={tw`flex-row flex-wrap justify-center mb-2`}>
                    {roundOptions.map((rounds) => (
                      <TouchableOpacity
                        key={rounds}
                        style={tw`${roundsOfGame === rounds ? "bg-red-600 border border-[#fe8b77]" : "bg-red-700"} p-3 rounded-lg mx-2 mb-2`}
                        onPress={() => handleSetRounds(rounds)}
                      >
                        <Text style={tw`text-white`}>{rounds} Rounds</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <LinearGradient
                    colors={["#9d0420", "#e9042e", "#9d0420"]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={tw`rounded-2xl mb-4 p-4 rounded-lg w-full p-4  mb-2 rounded-full mb-2`}
                  >
                    <TouchableOpacity style={tw` w-full flex justify-center items-center`} onPress={handleStartGame}>
                      <Text style={tw`text-white font-bold text-lg`}>Start Game</Text>
                    </TouchableOpacity>
                  </LinearGradient>
                </>
              ) : (
                <View style={tw`p-2 w-full flex flex-col justify-center items-center`}>
                  <View style={tw`flex flex-row justify-center opacity-70 items-center mb-4`}>
                    <Text style={tw`text-white`}>{players.length < 2 ? "Waiting for players" : "Waiting host"}</Text>
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
                        Send the game code to your friends so they can join!
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
                placeholder="Type a message..."
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
        title="Confirm Remove Player"
        message="Are you sure you want to remove"
        highlightedText={`@${selectedPlayer?.username}`}
        confirmText="Remove"
        cancelText="Cancel"
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
