import { useRef, useState } from "react";
import { Alert } from "react-native";
import type { Socket } from "socket.io-client";
import { useI18n } from "../i18n";
import { appendCapped, MAX_CHAT_MESSAGES } from "../utils/reactions";
import { CHAT_COOLDOWN_MS } from "../utils/protocolLimits";
import { AckSocket, emitAwaitingAck, hasBooleanOk } from "../utils/socketAck";
import { MutedNames, withoutMuted } from "./useMutedPlayers";

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

/** How long my message waits for chat-message's ack (the room got it) before it is not shown at all. */
export const CHAT_ACK_TIMEOUT_MS = 3000;

/**
 * chat-message's ack: the room got my message, as `message` says. That is the text as typed (there is no word filter,
 * EXP-438) but for the invisible and layout-breaking characters the server normalises (EXP-447).
 */
interface ChatMessageAck {
  ok: true;
  message: string;
}

const isChatMessageAck = (answer: unknown): answer is ChatMessageAck =>
  hasBooleanOk(answer) && answer.ok && "message" in answer && typeof answer.message === "string";

/**
 * Sends `message` to the room and resolves the text the room got once the server acks it, or null when there is no
 * ack: not connected, the connection dropped, the server dropped it (rate limit, nothing visible) or answered after
 * CHAT_ACK_TIMEOUT_MS.
 */
export const sendChatMessage = (socket: AckSocket, message: string): Promise<string | null> =>
  emitAwaitingAck(socket, "chat-message", [{ message }], isChatMessageAck, { timeoutMs: CHAT_ACK_TIMEOUT_MS })
    .then((ack) => ack?.message ?? null);

const newChatMessage = (username: string, message: string): LobbyChatMessage => ({
  id: `${Date.now()}-${Math.random()}`,
  username,
  message,
});

/**
 * The lobby chat: the messages on screen (the newest MAX_CHAT_MESSAGES, each one removed once its bubble fades out) and
 * sending, at most one message per CHAT_COOLDOWN_MS. My own message shows once the server acks it, as the room got it
 * (as typed, but for invisible or layout-breaking characters, EXP-447); without an ack it isn't shown and I'm told it
 * wasn't sent. Other players' messages come
 * in through `receive`, which the screen attaches with the rest of its socket handlers. The message being typed is the
 * chat footer's own state, so typing never re-renders the screen holding this hook (EXP-396). Players muted on this device (`muted`, EXP-422) are never shown: their messages are dropped as they
 * arrive, and muting removes the ones already on screen.
 */
export const useLobbyChat = (
  socket: Socket | null, gameCode: string | null, username: string | null, muted: MutedNames,
) => {
  const { t } = useI18n();
  // The room now, for an ack that comes back after I left the room it was sent in
  const currentGameCode = useRef(gameCode);
  currentGameCode.current = gameCode;
  const [messages, setMessages] = useState<LobbyChatMessage[]>([]);
  const [lastSentTime, setLastSentTime] = useState<number>(0);
  // Read by `receive`, which the screen attaches once with its socket handlers
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  // A mute removes that player's bubbles in the same render, not one after it
  const [messagesMuted, setMessagesMuted] = useState(muted);
  if (muted !== messagesMuted) {
    setMessagesMuted(muted);
    setMessages((prev) => withoutMuted(prev, muted));
  }

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
    if (!gameCode || !socket?.connected) return false;
    // The server doesn't echo it back to me: its ack says the room got it
    sendChatMessage(socket, message).then((relayed) => {
      if (currentGameCode.current !== gameCode) return; // left that room meanwhile: nothing to show there
      if (relayed !== null) show(newChatMessage(username || "You", relayed));
      else Alert.alert(t.error, t.chatMessageNotSent);
    });
    setLastSentTime(now);
    return true;
  };

  const receive = (data: IncomingChatMessage) => {
    if (data.username === username || mutedRef.current.has(data.username)) return;
    show(newChatMessage(data.username, data.message));
  };

  const remove = (id: string) => setMessages((prev) => prev.filter((msg) => msg.id !== id));

  const clear = () => setMessages([]);

  return { messages, send, receive, remove, clear };
};

export type LobbyChat = ReturnType<typeof useLobbyChat>;
