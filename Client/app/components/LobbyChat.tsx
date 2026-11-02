import React from "react";
import { Animated, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import tw from "twrnc";
import ChatMessage from "@/app/components/IngameComunication/ChatMessage";
import { useKeyboardPadding } from "@/app/hooks/useKeyboardPadding";
import type { LobbyChat } from "@/app/hooks/useLobbyChat";
import { useI18n } from "../i18n";
import { TEST_IDS } from "../utils/testIds";
import { MAX_CHAT_LENGTH } from "../utils/protocolLimits";

interface LobbyChatProps {
  chat: LobbyChat;
}

/** The chat bubbles, stacked under the top of the lobby; each one leaves once it has faded out. */
export const LobbyChatMessages = ({ chat }: LobbyChatProps) => (
  <View style={tw`absolute top-20 left-0 right-0 z-40 items-center`}>
    {chat.messages.map((msg) => (
      <ChatMessage
        key={msg.id}
        username={msg.username}
        message={msg.message}
        onAnimationEnd={() => chat.remove(msg.id)}
      />
    ))}
  </View>
);

/** The chat input and its send button, kept above the keyboard. */
export const LobbyChatFooter = ({ chat }: LobbyChatProps) => {
  const { t } = useI18n();
  const keyboardPadding = useKeyboardPadding();
  const blank = !chat.draft.trim();

  return (
    <Animated.View style={[tw`w-full mb-5`, { paddingBottom: keyboardPadding }]}>
      <View style={tw`px-2 py-2 flex-row items-center max-w-[500px] w-full self-center`}>
        <TextInput
          testID={TEST_IDS.chatInput}
          value={chat.draft}
          onChangeText={chat.setDraft}
          placeholder={t.typeMessage}
          placeholderTextColor="#999"
          style={tw`flex-1 bg-gray-800/90 text-white px-4 py-3 rounded-full mr-2`}
          maxLength={MAX_CHAT_LENGTH}
        />
        <TouchableOpacity
          testID={TEST_IDS.chatSendButton}
          accessibilityRole="button"
          accessibilityLabel={t.sendMessage}
          onPress={chat.send}
          disabled={blank}
          style={tw`rounded-full w-10 h-10 ${blank ? "bg-gray-600" : "bg-[#ff8605]"} items-center justify-center`}
        >
          <Ionicons name="send" size={20} color="white" />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
};
