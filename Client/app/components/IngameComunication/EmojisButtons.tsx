import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import tw from "twrnc";
import { useGameContext } from "../../providers/GameContext";
import { useRef } from "react";
import { REACTION_EMOJIS } from "../../utils/reactions";
import { emojiButtonId } from "../../utils/testIds";

function EmojisButton() {
  const { socket } = useGameContext();
  const lastSentRef = useRef(0);
  const COOLDOWN_TIME = 250; // 250ms cooldown

  // The server takes the sender and room from the socket's session
  const sendEmojiReaction = (emoji: string) => {
    const currentTime = Date.now();
    if (currentTime - lastSentRef.current < COOLDOWN_TIME || !socket) return;
    socket.emit("emoji-reaction", { emoji });
    lastSentRef.current = currentTime;
  };

  return (
    <View style={tw`absolute bottom-12 left-0 right-0 z-90`}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={tw`px-2 py-1 w-full flex-row justify-center`}
      >
        {REACTION_EMOJIS.map((emoji, index) => (
          <TouchableOpacity
            key={emoji}
            testID={emojiButtonId(index)}
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
