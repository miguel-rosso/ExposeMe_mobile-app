import React, { useCallback, useEffect, useState, useRef } from "react";
import { View, Text, FlatList, StatusBar, TouchableOpacity, Alert, Keyboard, Share, Image, TextStyle, ActivityIndicator } from "react-native";
import tw from "twrnc";
import { useGameContext } from "@/app/providers/GameContext";
import { useRouter, useLocalSearchParams, type Href } from "expo-router";
import type { Socket } from "socket.io-client";
import { RoomOfGameResponse, Player, GameStateSnapshot, PlayerConnectionData } from "@/app/models/interfaces";
import { useBackgroundContext } from "@/app/providers/BackgroundContext";
import { usePhotoContext } from "@/app/providers/PhotoContext";
import CloseButton from "@/app/components/CloseButton";
import AnimatedDot from "@/app/components/AnimatedDot";
import * as Animatable from "react-native-animatable";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import AlertModal from "@/app/components/modals/AlertModal";
import GalleryAccessModal from "@/app/components/modals/GalleryAccessModal";
import InviteConfirmModal from "@/app/components/modals/InviteConfirmModal";
import { useGalleryAccessGuard } from "@/app/hooks/useGalleryAccessGuard";
import { useLobbyChat } from "@/app/hooks/useLobbyChat";
import { useStartGame } from "@/app/hooks/useStartGame";
import { Ionicons } from "@expo/vector-icons";
import { LobbyChatFooter, LobbyChatMessages } from "@/app/components/LobbyChat";
import BusyOverlay from "@/app/components/BusyOverlay";
import SuccessAlert from "@/app/components/SuccessAlert";
import PlantPhotoButton from "@/app/components/PlantPhotoButton";
import { BRAND_RED } from "@/app/theme/brand";
import { INVITE_BASE_URL } from "@/config";
import { useI18n } from "../i18n";
import { TEST_IDS, lobbyPlayerId, lobbyPlayerOfflineId, roundsOptionId } from "../utils/testIds";
import { isHostIn, withConnection, withHost, withoutPlayer } from "../utils/roomPlayers";
import { attachHandlers, SocketHandlers } from "../utils/socketHandlers";
import { emitJoin, isConnectionRefused } from "../utils/roomJoin";
import { parseRoomCodeParam } from "../utils/roomCode";
import { linkStep, WaitingRoomMode } from "../utils/inviteLink";
import { normalizeUsername } from "../utils/username";
import { isKickedByHost, KICKED_BY_HOST_MESSAGE } from "../utils/serverMessage";
import { ROUND_OPTIONS } from "../utils/protocolLimits";
import { canOfferStart } from "../utils/startGame";
import { dismissKeyboardOnBackPress } from "../utils/keyboardBackPress";
import { GAME_SCREEN_ROUTE_NAME, gameScreenAtStart, RESYNC_GAME_SCREEN } from "../utils/gameScreenRoute";
import { HOME_PATH } from "../utils/homeRoute";
import { useGoHome } from "../hooks/useGoHome";
import { useRouteBelow } from "../hooks/useRouteBelow";
import { useBackHandler } from "@react-native-community/hooks";
import { gameWentBySince } from "../utils/plantedPhoto";

/** This screen's route */
const WAITING_ROOM_PATH = "/screens/WaitingRoom";

/** How much the lobby background photo is blurred */
const BACKDROP_BLUR_RADIUS = 10;

// ── Text shadows: keep the headings and hints legible over the background photo ──

const HEADING_SHADOW: TextStyle = {
  textShadowColor: "rgba(0, 0, 0, 0.5)",
  textShadowOffset: { width: 2, height: 2 },
  textShadowRadius: 5,
};
const TITLE_SHADOW: TextStyle = { ...HEADING_SHADOW, textShadowRadius: 4 };
const HINT_SHADOW: TextStyle = {
  textShadowColor: "rgba(0, 0, 0, 0.7)",
  textShadowOffset: { width: 1, height: 1 },
  textShadowRadius: 3,
};

/** A row of the player list: names are unique in a room */
const playerKey = (player: Player) => player.username;

const WaitingRoom = () => {
  const { t } = useI18n();
  const navigation = useRouter();
  const routeBelow = useRouteBelow();
  const { code: deepLinkCode } = useLocalSearchParams<{ code?: string | string[] }>();
  const {
    startSocket,
    endSocket,
    leaveRoom,
    gameCode,
    setGameCode,
    setPlayersProvider,
    socket,
    username,
    usernameLoaded,
    saveUsername,
    setJoinCodeDraft,
    takeNewRoomRequest,
    setRoundsOfGame,
    roundsOfGame,
    plantedPhotoUri,
    setPlantedPhotoUri,
    plantedPhotoSent,
    plantUpload,
    plantPhoto,
    saveRejoinToken,
    getRejoinToken,
    clearRejoinToken,
    setInviteOverRoomScreen,
  } = useGameContext();
  const [players, setPlayers] = useState<Player[]>([]);
  const { backgroundImage } = useBackgroundContext();
  const [dialogVisible, setDialogVisible] = useState<boolean>(false);
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const [showCopyMessage, setShowCopyMessage] = useState<boolean>(false);
  // Planted: the server has the photo picked on this device for this game (not while it uploads or after its upload
  // failed), or it has an earlier planted photo of mine: its own mark (only told to me in room-of-game: e.g. after
  // reopening the app in the lobby) or one sent from this lobby, kept while a replacement uploads (or fails)
  const [serverPlanted, setServerPlanted] = useState<boolean>(false);
  const hasPlantedPhoto = plantedPhotoSent || serverPlanted;
  const plantedUriRef = useRef(plantedPhotoUri);
  useEffect(() => { plantedUriRef.current = plantedPhotoUri; }, [plantedPhotoUri]);
  // Room's game number in this lobby's last room-of-game (null until the first): tells a game that went by (EXP-399)
  const lobbyGameNumberRef = useRef<number | null>(null);
  const { requestGalleryPermission } = usePhotoContext();
  const galleryGuard = useGalleryAccessGuard({ watch: true });
  const [showPhotoAddedMessage, setShowPhotoAddedMessage] = useState<boolean>(false);
  const [isSelecting, setIsSelecting] = useState<boolean>(false);
  // Until the room answers (or a started game's snapshot opens the game screen)
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const chat = useLobbyChat(socket, gameCode, username);
  const startRequest = useStartGame(socket);

  /** Forgets the picked photo: the game it was picked for was played without this lobby. */
  const dropPickedPhoto = () => {
    setPlantedPhotoUri(null);
    plantedUriRef.current = null;
  };

  /** Plants the picked photo; once one is in, the server keeps a planted photo of mine whatever a replacement does. */
  const plantPickedPhoto = async (): Promise<boolean> => {
    const sent = await plantPhoto();
    if (sent) setServerPlanted(true);
    return sent;
  };

  const pickAndPlantImage = async () => {
    if (!hasPlantedPhoto) {
      // First-time photo selection
      Alert.alert(t.plantSecretPhoto, t.choosePhotoDescription, [
        { text: t.cancel, style: "cancel" },
        { text: t.choosePhoto, onPress: async () => await selectImageFromGallery() },
      ]);
    } else {
      // Allow changing the already planted photo
      Alert.alert(t.photoAlreadyPlanted, t.changePhotoQuestion, [
        { text: t.keepCurrentPhoto, style: "cancel" },
        { text: t.changePhoto, onPress: async () => await selectImageFromGallery() },
      ]);
    }
  };

  const selectImageFromGallery = async () => {
    const hasPermission = await requestGalleryPermission({ askAgain: true });

    if (!hasPermission) {
      Alert.alert(t.permissionRequired, t.needPhotoAccess);
      return;
    }

    setIsSelecting(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: "images",
        // No crop: a square planted photo would stand out among the game's uncropped gallery photos
        allowsEditing: false,
        quality: 0.8,
      });

      setIsSelecting(false);

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const selectedImage = result.assets[0].uri;

        // Upload and plant it now, in the lobby: im-ready must never wait for it (if this fails, the game screen
        // retries after im-ready). Confirmed only once the server has it: a busy server can keep it waiting.
        setPlantedPhotoUri(selectedImage);
        plantedUriRef.current = selectedImage;
        if (!(await plantPickedPhoto())) return;
        setShowPhotoAddedMessage(true);
        setTimeout(() => {
          setShowPhotoAddedMessage(false);
        }, 2000);
      }
    } catch (error) {
      setIsSelecting(false);
      Alert.alert(t.error, t.errorSelectingImage);
    }
  };

  // Ref always holds current gameCode (avoids stale closures)
  const gameCodeRef = useRef(gameCode);
  useEffect(() => { gameCodeRef.current = gameCode; }, [gameCode]);
  const joinedRef = useRef(false);
  // Our binding from the last room-of-game (code + rejoin token), to ask for the game state again
  const bindingRef = useRef<{ gameCode: string; rejoinToken?: string } | null>(null);
  // Set when we enter a game that was already running (rejoin via "Join" after closing the app)
  const resyncOnLeaveRef = useRef(false);
  // Socket an invite link's Join made this lobby drop: still open until the server acks a leave, and the join effect
  // of this same commit still sees it as the context's socket, so it must not join from it
  const leftSocketRef = useRef<Socket | null>(null);
  // Where this screen stands (see WaitingRoomMode): set by its link, its own room's start and every way out. Read by
  // effects of the same commit that set it.
  const modeRef = useRef<WaitingRoomMode>("idle");
  const hasLeft = () => modeRef.current === "left";

  // Forget everything this lobby showed for the previous room (an invite link can switch rooms in place)
  const resetLobbyState = () => {
    setPlayers([]);
    chat.clear();
    setServerPlanted(false);
    lobbyGameNumberRef.current = null;
    setIsLoading(true);
    setDialogVisible(false);
    joinedRef.current = false;
    bindingRef.current = null;
  };

  /**
   * Drop whatever room the socket is in (or joining) before joining an invite link's room: a room it is bound to (this
   * lobby's, the game's under this screen, or the last game's) is left for good, like Exit; a join still unanswered
   * (e.g. Create game) is cut off with the socket. A code without a socket (e.g. typed on Home) binds nothing, and its
   * stored rejoin token may well belong to the linked room, so it is kept.
   */
  const releaseCurrentRoom = () => {
    if (!socket) return;
    leftSocketRef.current = socket;
    if (gameCodeRef.current) leaveRoom();
    else endSocket();
  };

  // Room of the invite link waiting for the player's Join (DEC-046), or null. The ref is read by effects of the same
  // commit that set it.
  const [invitedCode, setInvitedCode] = useState<string | null>(null);
  const invitedCodeRef = useRef<string | null>(null);
  // While it asks, the gallery notice only answers its Join (the DEC-015 gate): never shown, or asking for
  // permission, for a room the player has not confirmed yet
  const [inviteGalleryChecked, setInviteGalleryChecked] = useState(false);
  const setInvite = (code: string | null) => {
    invitedCodeRef.current = code;
    setInvitedCode(code);
    setInviteGalleryChecked(false);
  };

  // While the dialog asks over the room's own screen (e.g. the game's final screens), that screen knows which room it
  // asks about: it closes the dialog if it navigates on its own (the next game) and tells the player why (DEC-049)
  useEffect(() => {
    if (!invitedCode || modeRef.current !== "overRoomScreen") return;
    setInviteOverRoomScreen(invitedCode);
    return () => setInviteOverRoomScreen(null);
  }, [invitedCode]);

  // Unmounted (replaced, or closed by the room's screen): e.g. a Join still waiting for the gallery must do nothing
  useEffect(() => () => { modeRef.current = "left"; }, []);

  /** Back to the home under this screen, which shows `notice` (the server's reason) if there is one. */
  const goHomeFromRoom = useGoHome();
  const goHome = (notice?: string) => {
    modeRef.current = "left";
    goHomeFromRoom(notice);
  };

  /** Leave for home without joining. */
  const sendHome = () => {
    if (hasLeft()) return;
    endSocket();
    goHome();
  };

  /** This screen gives way to `href` (the game). */
  const replaceScreen = (href: Href) => {
    modeRef.current = "left";
    navigation.replace(href);
  };

  /** Back to the screen under this one (e.g. the game), as it was: the socket and its room are that screen's. */
  const backToRoomScreen = () => {
    if (hasLeft()) return;
    modeRef.current = "left";
    navigation.back();
  };

  /**
   * Join over the room's screen (e.g. the game): that screen and this one give way to a new lobby, opened over home
   * like home's Search room (the linked room's code is already set). The room's screen is gone before the linked room's
   * socket exists, so it never drives it (re-joins, im-ready, turn photos: EXP-359). Not a room exit (no useGoHome):
   * the room was already left (releaseCurrentRoom), home is never focused on the way, and the new lobby's startSocket
   * clears any exit mark still pending.
   */
  const openLinkedLobbyOverHome = () => {
    modeRef.current = "left";
    navigation.dismissTo(HOME_PATH);
    navigation.push(WAITING_ROOM_PATH);
  };

  /** Into the lobby of the room the app knows (no invite dialog left open): start (or reuse) its socket. */
  const startLobby = () => {
    setInvite(null);
    modeRef.current = "lobby";
    startSocket();
  };

  // On mount, and whenever an invite deep link (re)opens this screen (linkStep decides). A link to a room other than
  // ours asks the player to confirm (Join, with their name) before anything joins the linked one, and the room they
  // are in stays as it is until then (DEC-047). With no room code at all, the join would ask the server for a new room
  // (it creates one for a null/empty code): only home's Create game may do that, anything else (e.g. a link without a
  // valid code) goes home, or back to the room's screen it was opened over (EXP-363). Only a link opens it over that
  // screen: the app's own ways in never leave the game screen under it (routeBelow).
  useEffect(() => {
    const linkedCode = parseRoomCodeParam(deepLinkCode);
    const { step, mode } = linkStep({
      linkedCode,
      malformedLink: deepLinkCode !== undefined && !linkedCode,
      roomCode: gameCodeRef.current,
      roomScreenBelow: routeBelow() === GAME_SCREEN_ROUTE_NAME,
      mode: modeRef.current,
    });
    modeRef.current = mode;
    if (step === "ask") {
      console.log("Deep link code:", linkedCode);
      setInvite(linkedCode);
    } else if (step === "backToRoomScreen") {
      backToRoomScreen();
    } else if (step === "startLobby") {
      startLobby();
    } else if (step === "newRoomOrHome") {
      if (takeNewRoomRequest()) startLobby();
      else sendHome();
    }
  }, [deepLinkCode]);

  /**
   * Join (invite dialog): leave the room the player is in, if any, and join the linked room with the name confirmed
   * there, saved for later launches too.
   */
  const joinInvitedRoom = async (name: string) => {
    const code = invitedCodeRef.current;
    if (!code) return;
    // The same gate as home's Search room (DEC-015): without access the gallery notice says what is missing
    setInviteGalleryChecked(true);
    const access = await galleryGuard.check({ ask: true });
    // Another link replaced the dialog, or the screen left, while the gallery answered
    if (access?.status !== "ok" || invitedCodeRef.current !== code || hasLeft()) return;
    setInvite(null);
    releaseCurrentRoom();
    saveUsername(name);
    gameCodeRef.current = code;
    setGameCode(code);
    if (modeRef.current === "overRoomScreen") {
      openLinkedLobbyOverHome();
      return;
    }
    resetLobbyState();
    startLobby();
  };

  /**
   * Cancel (invite dialog, X, back): don't join the linked room, and go back to the room the player is in, unchanged
   * (DEC-047): this lobby (its link is cleared, so the same link can ask again), or the room's screen under this one
   * (e.g. the game). With no room, home.
   */
  const declineInvite = () => {
    setInvite(null);
    if (modeRef.current === "lobby") navigation.setParams({ code: undefined });
    else if (modeRef.current === "overRoomScreen") backToRoomScreen();
    else sendHome();
  };

  // Single effect: setup listeners, join room, handle reconnect. Only for this screen's own lobby: never before it
  // started one (e.g. its invite dialog asks over the game screen, whose socket stays that screen's) nor once left.
  useEffect(() => {
    if (!socket || !username || socket === leftSocketRef.current || modeRef.current !== "lobby") return;

    const doJoin = async () => {
      const code = gameCodeRef.current;
      console.log("Joining room:", code);
      setIsLoading(true);
      const rejoinToken = code ? await getRejoinToken(code, username) : null;
      emitJoin(socket, { gameCode: code, username, rejoinToken });
    };

    // Back to the home screen, which shows the reason (a server refusal, or kicked) in the user's language. Kicked
    // (player-removed, or a rejoin refused for it after missing that offline): the rejoin token is forgotten
    const leaveWithMessage = (message?: string) => {
      if (isKickedByHost(message)) clearRejoinToken();
      endSocket();
      goHome(message);
    };

    // This screen's own handlers. Only these are removed on unmount, so listeners that others attach to the shared
    // socket (e.g. the game screen, mounted in the same commit) survive whatever order React runs the effects in.
    const handlers: SocketHandlers = {
      connect: () => {
        console.log("Socket connected");
        doJoin();
      },

      // A refused connection would keep the loading screen spinning forever: home, with the server's reason
      connect_error: (err: Error) => {
        if (!isConnectionRefused(socket)) return;
        setIsLoading(false);
        leaveWithMessage(err.message);
      },

      "room-of-game": (data: RoomOfGameResponse) => {
        const { rejoinToken: _token, ...loggable } = data;
        console.log("Room data:", loggable);
        // A started game never paints the lobby: keep loading until its snapshot opens the game screen (EXP-108)
        setIsLoading(!!data.success && !!data.room?.started);
        if (!data.success) {
          // Home's join panel offers the refused room's code again (a typed one is already there; a link's would be lost)
          if (gameCodeRef.current) setJoinCodeDraft(gameCodeRef.current);
          leaveWithMessage(data.message);
        } else if (data.room) {
          joinedRef.current = true;
          bindingRef.current = { gameCode: data.room.gameCode, rejoinToken: data.rejoinToken };
          if (data.rejoinToken) saveRejoinToken(data.room.gameCode, username, data.rejoinToken);
          setPlayers(data.room.players);
          setGameCode(data.room.gameCode);
          setRoundsOfGame(data.room.rounds);
          // Lobby only (a rejoin into a started game leaves the planted photo alone): show the server's own mark,
          // and plant the picked photo again if the server doesn't have it (upload failed, or lost on a new socket),
          // unless a game started while we were away: it used or cleared that photo
          if (!data.room.started) {
            if (gameWentBySince(lobbyGameNumberRef.current, data.room.gameNumber)) dropPickedPhoto();
            lobbyGameNumberRef.current = data.room.gameNumber ?? null;
            setServerPlanted(!!data.hasPlantedPhoto);
            if (!data.hasPlantedPhoto && plantedUriRef.current) plantPickedPhoto();
          }
        }
      },

      "chat-message": chat.receive,

      "rounds-updated": (rounds: number) => setRoundsOfGame(rounds),
      "player-joined": (p: Player) => setPlayers((prev) => [...prev, p]),
      "player-left": (name: string) => setPlayers((prev) => withoutPlayer(prev, name)),
      "new-host": (h: Player) => setPlayers((prev) => withHost(prev, h.username)),
      "player-connection": (d: PlayerConnectionData) =>
        setPlayers((prev) => withConnection(prev, d.username, d.connected)),

      // The game screen gets the game's number: it tells its own game from the next one from the start (EXP-384)
      "game-started": (players: Player[], _rounds: number, gameNumber: number) => {
        setPlayersProvider(players);
        replaceScreen(gameScreenAtStart(gameNumber));
      },

      // Every rejoin is followed by a snapshot; a started game means we came back to a game in progress
      // (e.g. "Join" after closing the app): go straight to the game screen
      "game-state": (snap: GameStateSnapshot) => {
        if (!snap.started) {
          // A lobby rejoin's snapshot (not started, or the game is over): nothing more to wait for
          setIsLoading(false);
          return;
        }
        if (resyncOnLeaveRef.current) return;
        resyncOnLeaveRef.current = true;
        setPlayersProvider(snap.players);
        setRoundsOfGame(snap.totalRounds);
        replaceScreen(RESYNC_GAME_SCREEN);
      },

      "player-removed": (removed: Player) => {
        if (removed.username === username) {
          leaveWithMessage(KICKED_BY_HOST_MESSAGE);
        } else {
          setPlayers((prev) => withoutPlayer(prev, removed.username));
        }
      },
    };
    const detachHandlers = attachHandlers(socket, handlers);

    // If already connected, join now
    if (socket.connected) doJoin();

    return () => {
      detachHandlers();
      // The snapshot (and a your-turn for an awaited photo) reached this screen, not the game screen. The game
      // screen's listeners are attached in this same commit, before any server reply can arrive, so ask again:
      // a join on the same socket answers with a fresh snapshot (and your-turn) for the game screen to render.
      const binding = bindingRef.current;
      if (resyncOnLeaveRef.current && binding) {
        resyncOnLeaveRef.current = false;
        emitJoin(socket, { gameCode: binding.gameCode, username, rejoinToken: binding.rejoinToken });
      }
    };
  }, [socket, username]);

  // Opened without a name and with no invite dialog to type one in (home's Create and Search need one, so this is
  // only a safety net): nothing can join, go home. Until the saved name is read, the loading overlay stays.
  useEffect(() => {
    if (!usernameLoaded || normalizeUsername(username) || invitedCodeRef.current) return;
    sendHome();
  }, [usernameLoaded, username, invitedCode]);

  /** Exit: leave the room for good (leave-room, so the server frees the name and hands the host role over) and go home. */
  const handleLeaveGame = () => {
    if (hasLeft()) return;
    leaveRoom();
    goHome();
  };

  /**
   * The close button (X), Android back and the gallery notice's Back. While the invite dialog asks they are its
   * Cancel: back to the room the player is in, or home leaving nothing when there is none (a leave would forget the
   * stored rejoin token, e.g. of a game in progress in the linked room).
   */
  const handleClose = () => (invitedCodeRef.current ? declineInvite() : handleLeaveGame());

  // Android back (the key and the back gesture) is Exit too: popping the lobby would only close the socket, keeping
  // this player in the room as a lost connection (EXP-336). With the chat keyboard open it only closes the keyboard
  // (EXP-064), and with the remove-player confirmation open (an overlay, not a native modal) it only closes that.
  // With the invite dialog open it is its Cancel. iOS has no back here: the route disables the swipe (app/_layout.tsx).
  useBackHandler(() => {
    if (dismissKeyboardOnBackPress(Keyboard)) return true;
    if (dialogVisible) {
      setDialogVisible(false);
      return true;
    }
    handleClose();
    return true;
  });

  const handleSetRounds = (rounds: number) => {
    setRoundsOfGame(rounds);
    if (socket) {
      socket.emit("set-rounds", { gameCode, rounds });
    }
  };

  const handleRemovePlayer = (target: string) => {
    if (socket) {
      socket.emit("remove-player", { gameCode, username: target });
    }
  };

  // Only state setters: the same function on every render, for the memoized player rows
  const confirmRemovePlayer = useCallback((player: Player) => {
    setSelectedPlayer(player);
    setDialogVisible(true);
  }, []);

  const shareGameCode = async () => {
    if (!gameCode) return;
    try {
      await Share.share({
        message: t.shareMessage + `${INVITE_BASE_URL}/${gameCode}`,
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

  const isHost = isHostIn(players, username);
  // Gone players don't count: the server removes them at the start (EXP-379)
  const canStart = canOfferStart(players);

  // Memoized: the player list (a PureComponent) only re-renders its rows when the players or the host change, not on
  // every other lobby update (chat bubbles, notices: EXP-396)
  const renderPlayer = useCallback(({ item }: { item: Player }) => {
    const isMe = item.username === username;
    const offline = item.connected === false;
    return (
      <TouchableOpacity
        testID={lobbyPlayerId(item.username)}
        onPress={() => {
          if (isHost && !isMe) confirmRemovePlayer(item);
        }}
        activeOpacity={isMe || !isHost ? 1 : 0.7}
        style={[
          tw`flex-row items-center px-4 py-3 mb-2 rounded-2xl`,
          {
            backgroundColor: isMe ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.45)",
            borderWidth: 1,
            borderColor: isMe ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.12)",
            opacity: offline ? 0.5 : 1,
          },
        ]}
      >
        <View style={tw`h-9 w-9 rounded-full bg-white/10 items-center justify-center mr-3`}>
          {item.isHost ? (
            <Text style={tw`text-sm`}>👑</Text>
          ) : (
            <Text style={tw`text-white text-sm font-bold opacity-50`}>
              {item.username.charAt(0).toUpperCase()}
            </Text>
          )}
        </View>
        <Text style={tw`text-white text-base flex-1 ${isMe ? "font-bold" : "font-medium"}`}>
          {item.username}
        </Text>
        {offline && (
          <Text testID={lobbyPlayerOfflineId(item.username)} style={tw`text-white/60 text-xs italic mr-2`}>
            {t.playerDisconnected}
          </Text>
        )}
        {isMe && <Text style={tw`text-white/40 text-xs`}>{t.you}</Text>}
      </TouchableOpacity>
    );
  }, [username, isHost, t, confirmRemovePlayer]);

  return (
    <View style={tw`flex-1`}>
      <View style={tw`absolute w-full h-full`}>
        <StatusBar hidden />
        {/* Blurred background: one image, no layout/measure round trips (EXP-262) */}
        <Image source={backgroundImage} blurRadius={BACKDROP_BLUR_RADIUS} resizeMode="cover" style={tw`w-full h-full`} />
      </View>
      <CloseButton onPress={handleClose} accessibilityLabel={invitedCode ? t.cancel : t.leaveRoom} />

      <LobbyChatMessages chat={chat} />

      {/* Loading overlay and notifications */}
      {isLoading && <BusyOverlay testID={TEST_IDS.lobbyLoading} title={t.loadingGameRoom} subtitle={t.pleaseWait} />}

      {/* Copy notification overlay - centered on screen */}
      {showCopyMessage && <SuccessAlert text={t.gameCodeCopied} />}

      {/* Photo Added notification overlay */}
      {showPhotoAddedMessage && <SuccessAlert text={t.photoSelectedForGame} />}

      {/* Photo selection */}
      {isSelecting && <BusyOverlay title={t.selectingPhoto} />}

      {/* Main container */}
      <View style={tw`flex-1`}>
        <View style={tw`flex-1 flex `}>
          {/* Main content area */}
          <View style={tw`flex-1 pt-14 px-4 max-w-[500px] w-full self-center ${isLoading ? "opacity-0" : "opacity-100"}`}>
            <View style={tw`items-center mb-2`}>
              <Text style={[tw`text-xl text-white font-bold mb-1`, TITLE_SHADOW]}>{t.gameCode}</Text>

              <View style={tw`flex-row items-center mb-1 max-w-full`}>
                <TouchableOpacity
                  testID={TEST_IDS.copyCodeButton}
                  accessibilityRole="button"
                  accessibilityLabel={t.copyGameCode}
                  onPress={copyGameCodeToClipboard}
                  style={tw`p-2`}
                >
                  <Ionicons name="copy-outline" size={24} color="rgba(255,255,255,0.7)" />
                </TouchableOpacity>
                {/* Letters are wider than digits: shrink rather than wrap or clip on narrow screens */}
                <Text
                  testID={TEST_IDS.lobbyGameCode}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  style={[
                    tw`text-5xl text-white font-extrabold mx-1 shrink`,
                    { lineHeight: 60, ...HEADING_SHADOW },
                  ]}
                >
                  {gameCode}
                </Text>
                <TouchableOpacity
                  testID={TEST_IDS.shareCodeButton}
                  accessibilityRole="button"
                  accessibilityLabel={t.shareGameCode}
                  onPress={shareGameCode}
                  style={tw`p-2`}
                >
                  <Ionicons name="share-social-outline" size={24} color="rgba(255,255,255,0.7)" />
                </TouchableOpacity>
              </View>

              <Text style={[tw`text-white font-extrabold mb-2`, HEADING_SHADOW]}>
                {roundsOfGame} {t.rounds}
              </Text>

              <PlantPhotoButton
                planted={hasPlantedPhoto}
                uploading={plantUpload === "uploading"}
                failed={plantUpload === "failed"}
                disabled={isSelecting}
                onPress={pickAndPlantImage}
              />
            </View>

            {/* Player list with limited height */}
            <FlatList
              data={players}
              renderItem={renderPlayer}
              keyExtractor={playerKey}
              style={tw`w-full flex-1`}
              contentContainerStyle={tw`pb-2`}
            />

            {/* Bottom controls section */}
            <View style={tw`w-full mt-2 mb-4`}>
              {startRequest.notice && (
                <Text testID={TEST_IDS.startGameNotice} style={[tw`text-red-300 font-medium text-center mb-2`, HINT_SHADOW]}>
                  {startRequest.notice}
                </Text>
              )}
              {isHost && canStart ? (
                <>
                  {/* Round selector — pill style */}
                  <View style={[tw`flex-row justify-center mb-3 rounded-full p-1`, { backgroundColor: "rgba(255,255,255,0.08)" }]}>
                    {ROUND_OPTIONS.map((rounds) => (
                      <TouchableOpacity
                        key={rounds}
                        testID={roundsOptionId(rounds)}
                        onPress={() => handleSetRounds(rounds)}
                        // Fixed once Start is pressed: the game starts with the rounds the server has then
                        disabled={startRequest.starting}
                        accessibilityRole="button"
                        accessibilityLabel={`${rounds} ${t.rounds}`}
                        accessibilityState={{ disabled: startRequest.starting, selected: roundsOfGame === rounds }}
                        style={[
                          tw`flex-1 py-2 rounded-full items-center ${startRequest.starting ? "opacity-70" : ""}`,
                          roundsOfGame === rounds ? { backgroundColor: BRAND_RED } : {},
                        ]}
                      >
                        <Text style={tw`text-white text-sm ${roundsOfGame === rounds ? "font-bold" : "opacity-60"}`}>
                          {rounds}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  {/* Start button:"Starting…" and disabled until game-started or the server's answer */}
                  <TouchableOpacity
                    testID={TEST_IDS.startGameButton}
                    onPress={startRequest.start}
                    disabled={startRequest.starting}
                    accessibilityState={{ disabled: startRequest.starting, busy: startRequest.starting }}
                    activeOpacity={0.8}
                    style={[
                      tw`w-full py-4 rounded-2xl flex-row justify-center items-center ${startRequest.starting ? "opacity-70" : ""}`,
                      { backgroundColor: BRAND_RED },
                    ]}
                  >
                    {startRequest.starting && <ActivityIndicator color="white" style={tw`mr-2`} />}
                    <Text style={tw`text-white font-bold text-lg`}>
                      {startRequest.starting ? t.startingGame : t.startGame}
                    </Text>
                  </TouchableOpacity>
                </>
              ) : (
                <View style={tw`p-2 w-full flex flex-col justify-center items-center`}>
                  <View testID={TEST_IDS.lobbyWaiting} style={tw`flex flex-row justify-center opacity-70 items-center mb-4`}>
                    <Text style={tw`text-white`}>{canStart ? t.waitingHost : t.waitingForPlayers}</Text>
                    <View style={tw`flex-row`}>
                      <AnimatedDot delay={0} />
                      <AnimatedDot delay={200} />
                      <AnimatedDot delay={400} />
                    </View>
                  </View>

                  {/* Host explanation message */}
                  {isHost && !canStart && (
                    <Animatable.View testID={TEST_IDS.lobbyHostHint} animation="fadeIn">
                      <Text style={[tw`text-white text-center italic opacity-80 `, HINT_SHADOW]}>
                        {t.sendCodeToFriends}
                      </Text>
                    </Animatable.View>
                  )}
                </View>
              )}
            </View>
          </View>
          <LobbyChatFooter chat={chat} />
        </View>
      </View>

      {/* Remove-player confirmation (host only) */}
      <AlertModal
        visible={dialogVisible}
        title={t.confirmRemovePlayer}
        message={t.areYouSureRemove}
        highlightedText={selectedPlayer ? `@${selectedPlayer.username}` : undefined}
        confirmText={t.remove}
        cancelText={t.cancel}
        onConfirm={() => {
          if (selectedPlayer) {
            handleRemovePlayer(selectedPlayer.username);
          }
          setDialogVisible(false);
        }}
        onCancel={() => setDialogVisible(false)}
        confirmButtonColor="bg-red-600"
        cancelButtonColor="bg-blue-500"
      />

      {/* Invite link: nothing joins until Join (the saved name is read first, to fill it in) */}
      {invitedCode && usernameLoaded && (
        <InviteConfirmModal
          key={invitedCode}
          roomCode={invitedCode}
          initialName={normalizeUsername(username)}
          onJoin={joinInvitedRoom}
          onCancel={declineInvite}
        />
      )}

      {/* No photo access / no photos (re-checked on foreground): can't stay in the lobby without them */}
      <GalleryAccessModal
        access={invitedCode && !inviteGalleryChecked ? null : galleryGuard.blocked}
        onAllow={() => galleryGuard.check({ ask: true })}
        onSelectPhotos={galleryGuard.selectMore}
        onRetry={() => galleryGuard.check({ ask: false })}
        onBack={handleClose}
        blocking
      />
    </View>
  );
};

export default WaitingRoom;
