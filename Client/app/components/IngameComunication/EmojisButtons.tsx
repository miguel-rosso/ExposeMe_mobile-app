import { ScrollView, Text, TouchableOpacity, View, Platform } from "react-native";
import tw from "twrnc";
import { useGameContext } from "../../providers/GameContext";
import { useEffect, useState } from "react";
import * as ScreenCapture from "expo-screen-capture";

function EmojisButton() {
  const EMOJIS = ["😂", "😍", "❓", "😳", "🔥", "😭", "🤡", "😡"];
  const { socket, username, gameCode } = useGameContext();
  const safeUsername = username ?? "";
  const safeGameCode = gameCode ?? "";
  const [lastSentTime, setLastSentTime] = useState(0);
  const COOLDOWN_TIME = 250; // 250ms cooldown

  // Function to send emoji reaction
  const sendEmojiReaction = (emoji: string) => {
    const currentTime = Date.now();

    // Check if cooldown period has passed
    if (currentTime - lastSentTime >= COOLDOWN_TIME) {
      if (socket) {
        socket.emit("emoji-reaction", {
          gameCode: safeGameCode,
          username: safeUsername,
          emoji,
        });
        setLastSentTime(currentTime);
      }
    }
  };

  // Set up screenshot detection
  useEffect(() => {
    const subscribeToScreenCapture = async () => {
      // Only available on iOS and Android
      if (Platform.OS === "ios" || Platform.OS === "android") {
        // Add screenshot listener
        const subscription = ScreenCapture.addScreenshotListener(() => {
          // When screenshot is detected, send the screenshot emoji reaction
          sendEmojiReaction("📸 Took a Screenshot");
        });

        return () => {
          // Cleanup
          subscription.remove();
        };
      }
    };

    subscribeToScreenCapture();
  }, [socket, safeGameCode, safeUsername]);

  return (
    <View style={tw`absolute bottom-12 left-0 right-0 z-90`}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={tw`px-2 py-1 w-full flex-row justify-center`}
      >
        {EMOJIS.map((emoji, index) => (
          <TouchableOpacity
            key={index}
            style={tw`mx-1 bg-gray-800 bg-opacity-80 rounded-full h-10 w-10 items-center justify-center`}
            onPress={() => sendEmojiReaction(emoji)}
          >
            <Text style={tw`text-2xl`}>{emoji}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

export default EmojisButton;
