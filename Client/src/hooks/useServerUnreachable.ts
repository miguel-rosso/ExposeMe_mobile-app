import { useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";

/**
 * How long a screen waits for the socket to connect before telling the player it can't reach the server (EXP-417).
 * Long enough for a slow network, short enough that nobody takes the spinner for a hung app.
 */
export const SERVER_UNREACHABLE_AFTER_MS = 12_000;

/** The part of a socket.io client socket this watches */
export type WatchedSocket = Pick<Socket, "connected" | "on" | "off" | "connect">;

interface ServerUnreachable {
  /** True once `waiting` has lasted SERVER_UNREACHABLE_AFTER_MS without the socket connecting */
  unreachable: boolean;
  /** Make sure the socket is trying to connect and give it the full wait again */
  retry: () => void;
}

/** Whether `socket` is connected right now, following its connect / disconnect events. */
const useSocketConnected = (socket: WatchedSocket | null): boolean => {
  const [connected, setConnected] = useState(socket?.connected ?? false);
  useEffect(() => {
    setConnected(socket?.connected ?? false);
    if (!socket) return;
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [socket]);
  return connected;
};

/**
 * While a screen `waiting` for the server has a socket that doesn't connect (no network, server down or cold-starting),
 * tells it when to stop showing a bare spinner. It never stops the socket's own reconnection: a connection that comes
 * later clears it, and the screen carries on as usual.
 */
export const useServerUnreachable = (socket: WatchedSocket | null, waiting: boolean): ServerUnreachable => {
  const connected = useSocketConnected(socket);
  const waitingForConnection = waiting && !!socket && !connected;
  const [timedOut, setTimedOut] = useState(false);
  // Bumped by retry: starts the wait over
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setTimedOut(false);
    if (!waitingForConnection) return;
    const timer = setTimeout(() => setTimedOut(true), SERVER_UNREACHABLE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waitingForConnection, attempt]);

  // socket.io keeps retrying on its own (reconnectionAttempts: Infinity); connect() only restarts a socket that
  // stopped, and does nothing while its next attempt is already scheduled (at most reconnectionDelayMax away)
  const retry = useCallback(() => {
    socket?.connect();
    setAttempt((n) => n + 1);
  }, [socket]);

  return { unreachable: waitingForConnection && timedOut, retry };
};
