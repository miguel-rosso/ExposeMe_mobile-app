import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import tw from "twrnc";
import { useGameContext } from "../../providers/GameContext";
import { memo, useRef } from "react";
import { REACTION_EMOJIS } from "../../utils/reactions";
import { emojiButtonId } from "../../utils/testIds";
import { emitWhileConnected } from "../../utils/socketEmit";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { safeBottomRow } from "../../utils/safeAreaRows";
import { EMOJI_ROW_BOTTOM } from "../../utils/gameRows";

function EmojisButton() {
  const { socket } = useGameContext();
  const insets = useSafeAreaInsets();
  const lastSentRef = useRef(0);
  const COOLDOWN_TIME = 250; // 250ms cooldown

  // The server takes the sender and room from the socket's session
  const sendEmojiReaction = (emoji: string) => {
    const currentTime = Date.now();
    if (currentTime - lastSentRef.current < COOLDOWN_TIME) return;
    // Offline it is dropped, not buffered: the server would drop it before the rejoin anyway
    if (emitWhileConnected(socket, "emoji-reaction", { emoji })) lastSentRef.current = currentTime;
  };

  return (
    <View style={[tw`absolute z-90`, safeBottomRow(insets, EMOJI_ROW_BOTTOM)]}>
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

// Memoised: it takes no props, the game screen re-renders on every phase and pick (EXP-265)
export default memo(EmojisButton);
