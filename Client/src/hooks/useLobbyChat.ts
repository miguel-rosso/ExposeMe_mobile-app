import { useState } from "react";
import { Alert } from "react-native";
import type { Socket } from "socket.io-client";
import { useI18n } from "../i18n";
import { appendCapped, MAX_CHAT_MESSAGES } from "../utils/reactions";
import { CHAT_COOLDOWN_MS } from "../utils/protocolLimits";
import { emitWhileConnected } from "../utils/socketEmit";

/** A message on the lobby chat: mine or another player's */
export interface LobbyChatMessage {
  id: string;
  username: string;
  message: string;
}

/** What the server's chat-message event carries */
interface IncomingChatMessage {
  username: string;
  message: string;
}

const newChatMessage = (username: string, message: string): LobbyChatMessage => ({
  id: `${Date.now()}-${Math.random()}`,
  username,
  message,
});

/**
 * The lobby chat: the messages on screen (the newest MAX_CHAT_MESSAGES, each one removed once its bubble fades out) and
 * sending, at most one message per CHAT_COOLDOWN_MS. Other players' messages come in through `receive`, which the
 * screen attaches with the rest of its socket handlers. The message being typed is the chat footer's own state, so
 * typing never re-renders the screen holding this hook (EXP-396).
 */
export const useLobbyChat = (socket: Socket | null, gameCode: string | null, username: string | null) => {
  const { t } = useI18n();
  const [messages, setMessages] = useState<LobbyChatMessage[]>([]);
  const [lastSentTime, setLastSentTime] = useState<number>(0);

  const show = (msg: LobbyChatMessage) => setMessages((prev) => appendCapped(prev, msg, MAX_CHAT_MESSAGES));

  /** Sends the typed text; true when it went out (false: blank, within the cooldown, or offline) */
  const send = (text: string): boolean => {
    const message = text.trim();
    if (!message) return false;
    const now = Date.now();
    if (now - lastSentTime < CHAT_COOLDOWN_MS) {
      Alert.alert(t.slowDown, t.pleaseWaitBeforeSending);
      return false;
    }
    // Offline it is not sent (nor shown): the text stays in the input to send once back
    const sent = !!gameCode && emitWhileConnected(socket, "chat-message", { message });
    if (!sent) return false;
    // The server doesn't echo it back to me: show it here
    show(newChatMessage(username || "You", message));
    setLastSentTime(now);
    return true;
  };

  const receive = (data: IncomingChatMessage) => {
    if (data.username !== username) show(newChatMessage(data.username, data.message));
  };

  const remove = (id: string) => setMessages((prev) => prev.filter((msg) => msg.id !== id));

  const clear = () => setMessages([]);

  return { messages, send, receive, remove, clear };
};

export type LobbyChat = ReturnType<typeof useLobbyChat>;
