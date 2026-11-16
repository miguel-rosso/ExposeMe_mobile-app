import React, { useState } from "react";
import { Animated, Keyboard, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons/static";
import tw from "twrnc";
import ChatMessage from "@/src/components/IngameComunication/ChatMessage";
import { useKeyboardPadding } from "@/src/hooks/useKeyboardPadding";
import type { LobbyChat, LobbyChatMessage } from "@/src/hooks/useLobbyChat";
import { useI18n } from "../i18n";
import { TEST_IDS } from "../utils/testIds";
import { MAX_CHAT_LENGTH } from "../utils/protocolLimits";

interface LobbyChatProps {
  chat: LobbyChat;
}

interface LobbyChatMessagesProps extends LobbyChatProps {
  /** This device's player: their own bubbles can't be reported */
  myUsername: string | null;
  /** Opens the report dialog for another player's message (EXP-423) */
  onReport: (msg: LobbyChatMessage) => void;
}

/**
 * The chat bubbles, centred and filling the area they are placed in: the lobby puts them over everything between the
 * room code and the chat input, so they never cover the code or its copy and share buttons (EXP-411). They stack up
 * from the bottom, the newest nearest the input; when the keyboard leaves too little room, the oldest are cut off at
 * the top. Each one leaves once it has faded out. Taps go through them to the controls underneath, except on the
 * report flag of another player's bubble.
 */
export const LobbyChatMessages = ({ chat, myUsername, onReport }: LobbyChatMessagesProps) => (
  <View
    testID={TEST_IDS.lobbyChatMessages}
    style={[tw`absolute inset-0 z-40 items-center justify-end overflow-hidden`, { pointerEvents: "box-none" }]}
  >
    {chat.messages.map((msg) => (
      <ChatMessage
        key={msg.id}
        username={msg.username}
        message={msg.message}
        onAnimationEnd={() => chat.remove(msg.id)}
        onReport={msg.username === myUsername ? undefined : () => onReport(msg)}
      />
    ))}
  </View>
);

/**
 * The chat input and its send button, kept above the keyboard. The keyboard's return key ("send") sends too and keeps
 * the keyboard up to go on chatting; with nothing typed it closes the keyboard. The button closes it once the message
 * is out. Those are the lobby's ways back to the room on iOS, which has no back key for the keyboard. A refused send
 * (cooldown, offline) leaves the keyboard up with the text still in it. The text being typed is this footer's own
 * state: a keystroke re-renders only the footer, not the whole lobby (EXP-396).
 */
export const LobbyChatFooter = ({ chat }: LobbyChatProps) => {
  const { t } = useI18n();
  const keyboardPadding = useKeyboardPadding();
  const [draft, setDraft] = useState<string>("");
  const blank = !draft.trim();
  /** Sends the draft and empties the input once it went out; true when it did */
  const sendDraft = (): boolean => {
    if (!chat.send(draft)) return false;
    setDraft("");
    return true;
  };
  const sendAndCloseKeyboard = () => {
    if (sendDraft()) Keyboard.dismiss();
  };
  const handleReturnKey = () => {
    if (blank) Keyboard.dismiss();
    else sendDraft();
  };

  return (
    <Animated.View style={[tw`w-full mb-5`, { paddingBottom: keyboardPadding }]}>
      <View style={tw`px-2 py-2 flex-row items-center max-w-[500px] w-full self-center`}>
        <TextInput
          testID={TEST_IDS.chatInput}
          value={draft}
          onChangeText={setDraft}
          placeholder={t.typeMessage}
          placeholderTextColor="#999"
          style={tw`flex-1 bg-gray-800/90 text-white px-4 py-3 rounded-full mr-2`}
          maxLength={MAX_CHAT_LENGTH}
          returnKeyType="send"
          submitBehavior="submit"
          onSubmitEditing={handleReturnKey}
        />
        <TouchableOpacity
          testID={TEST_IDS.chatSendButton}
          accessibilityRole="button"
          accessibilityLabel={t.sendMessage}
          onPress={sendAndCloseKeyboard}
          disabled={blank}
          style={tw`rounded-full w-10 h-10 ${blank ? "bg-gray-600" : "bg-[#ff8605]"} items-center justify-center`}
        >
          <Ionicons name="send" size={20} color="white" />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
};
