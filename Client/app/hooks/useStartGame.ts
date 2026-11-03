import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { AckSocket } from "../utils/socketAck";
import { sendStartGame, StartGameAck, startNoticeText } from "../utils/startGame";

/** How long the notice explaining a start that didn't happen stays under the lobby's controls. */
export const START_NOTICE_MS = 5000;

export interface StartGameRequest {
  /** start-game was sent and neither its ack nor game-started has come yet (or it was accepted: the game opens). */
  starting: boolean;
  /** Why the last start didn't happen, in the user's language, for START_NOTICE_MS; null otherwise. */
  notice: string | null;
  /** The host's Start: ignored while one is pending. */
  start: () => void;
}

/**
 * The host's Start in the lobby (EXP-379): sends start-game and waits for its ack, so the button can show it is
 * starting and, when the server refuses or doesn't answer, be usable again with a notice saying why. An accepted
 * start stays "starting": game-started (sent before the ack) opens the game screen.
 */
export function useStartGame(socket: AckSocket | null | undefined): StartGameRequest {
  const { t } = useI18n();
  const [starting, setStarting] = useState(false);
  // The answer to the last start that didn't happen (null: none came), while its notice shows
  const [failure, setFailure] = useState<{ ack: StartGameAck | null } | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!failure) return;
    const timer = setTimeout(() => setFailure(null), START_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [failure]);

  const start = async () => {
    if (!socket || pendingRef.current) return;
    pendingRef.current = true;
    setStarting(true);
    setFailure(null);
    const ack = await sendStartGame(socket);
    if (!mountedRef.current || ack?.ok) return;
    pendingRef.current = false;
    setStarting(false);
    setFailure({ ack });
  };

  const notice = failure && startNoticeText(failure.ack, t);
  return { starting, notice, start };
}
