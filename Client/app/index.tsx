import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Image,
  TouchableWithoutFeedback,
  Keyboard,
  Dimensions,
  Alert,
  LayoutChangeEvent,
} from "react-native";
import tw from "twrnc";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import InitialScreen from "@/app/screens/InitialScreen";
import { useGameContext } from "@/app/providers/GameContext";
import { useLocalSearchParams } from "expo-router";
import { StatusBar } from "react-native";
import * as Animatable from "react-native-animatable";
import { useBackHandler } from "@react-native-community/hooks";
import { useFocusEffect } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useBackgroundContext } from "./providers/BackgroundContext";
import { useGalleryAccessGuard } from "@/app/hooks/useGalleryAccessGuard";
import { useExitAnimationNavigation } from "@/app/hooks/useExitAnimationNavigation";
import GalleryAccessModal from "@/app/components/modals/GalleryAccessModal";
import { Ionicons } from "@expo/vector-icons";
import { useI18n } from "./i18n";
import LanguageToggle from "./components/LanguageToggle";
import LimitedAccessBanner from "./components/LimitedAccessBanner";
import BrandButton from "./components/BrandButton";
import { BRAND_DISPLAY_FONT, BRAND_LOGO_SHADOW } from "./theme/brand";
import {
  HOME_ANIMATION_MS,
  REAPPEAR_BOUNCE_DOWN,
  REAPPEAR_BOUNCE_UP,
  registerHomeAnimations,
  SHAKE_MS,
} from "./theme/homeAnimations";
import { TEST_IDS } from "./utils/testIds";
import { handleHomeBackPress } from "./utils/homeBackPress";
import { isRoomCode, sanitizeRoomCodeInput } from "./utils/roomCode";
import { translateServerMessage } from "./utils/serverMessage";
import { MAX_USERNAME_INPUT_LENGTH } from "./utils/protocolLimits";
import { normalizeUsername, USERNAME_STORAGE_KEY } from "./utils/username";
import {
  HOME_TOP_ROW_HEIGHT,
  HOME_TOP_ROW_TOP,
  LOGO_BOX_HEIGHT,
  LOGO_EMOJI_BOX_PERCENT,
  LOGO_EMOJI_TOP,
  logoEmojiScale,
} from "./utils/homeLayout";

SplashScreen.preventAutoHideAsync();

/** How much the home background photo is blurred */
const BACKDROP_BLUR_RADIUS = 3;

registerHomeAnimations();

const Index = () => {
  const router = useRouter();
  const params = useLocalSearchParams();
  const message = params?.message;
  const [isLoading, setIsLoading] = useState(true);
  const [hasSeenInitialScreen, setHasSeenInitialScreen] = useState(false);
  const {
    setUsername,
    username,
    setGameCode,
    joinCodeDraft,
    setJoinCodeDraft,
    socket,
    endSocket,
    pendingInviteCode,
    setPendingInviteCode,
    requestNewRoom,
  } = useGameContext();
  const { backgroundImage } = useBackgroundContext();
  const [isJoiningGame, setIsJoiningGame] = useState(false);
  // The join panel also asks for the name (opened for an invite link that came without one)
  const [askNameToJoin, setAskNameToJoin] = useState(false);
  const [shouldAnimateCreateGameButton, setShouldAnimateCreateGameButton] = useState(false);
  const [isFirstMount, setIsFirstMount] = useState(true);
  const gameCodeInputRef = useRef<TextInput>(null);
  const usernameInputRef = useRef<Animatable.View & View>(null);
  const gameCodeAnimRef = useRef<Animatable.View & View>(null);
  const createGameButtonRef = useRef<Animatable.View & View>(null);
  const JoingameButtonRef = useRef<Animatable.View & View>(null);
  const buttonRef = useRef<Animatable.View & View>(null);
  const textRef = useRef<Animatable.View & View>(null);
  const topLogoRef = useRef<Animatable.View & View>(null);
  const { t } = useI18n();
  // Playing needs photo access (full or limited) and at least one photo: checked on Create / Search room
  const galleryGuard = useGalleryAccessGuard({ watch: false });
  const ensureGalleryAccess = async () => (await galleryGuard.check({ ask: true }))?.status === "ok";

  // Measured so the logo emoji can shrink clear of the limited-access banner (EXP-281); null = not shown / not laid out
  const [logoTop, setLogoTop] = useState<number | null>(null);
  const [bannerBottom, setBannerBottom] = useState<number | null>(null);
  const emojiScale = logoEmojiScale(logoTop, bannerBottom);
  const handleLogoLayout = (e: LayoutChangeEvent) => setLogoTop(e.nativeEvent.layout.y);
  // The banner renders nothing with full (or no) access: its wrapper is then 0 high
  const handleBannerLayout = (e: LayoutChangeEvent) => {
    const { y, height: bannerHeight } = e.nativeEvent.layout;
    setBannerBottom(bannerHeight > 0 ? HOME_TOP_ROW_TOP + y + bannerHeight : null);
  };

  // The logo's font size follows the screen width
  const { width } = Dimensions.get('window');
  const getTitleFontSize = () => {
    // Base size for standard screens (adjust these thresholds as needed)
    if (width >= 400) {
      return 'text-8xl'; // Large screens
    } else if (width >= 350) {
      return 'text-7xl'; // Medium screens
    } else {
      return 'text-6xl'; // Small screens
    }
  };

  // Initial data: whether the first-run screen was seen, and the server notice that sent us home
  useEffect(() => {
    const checkInitialScreen = async () => {
      const value = await AsyncStorage.getItem("hasSeenInitialScreen");
      setHasSeenInitialScreen(value === "true");
      setIsLoading(false);
    };

    // The saved name is loaded by GameProvider at app start
    checkInitialScreen();

    // The server's reason for sending us home (room-of-game refusal, connection refused, kicked), in our language
    const serverMessage = Array.isArray(message) ? message[0] : message;
    if (serverMessage) {
      Alert.alert(t.serverNoticeTitle, translateServerMessage(serverMessage, t), [{ text: t.ok }]);
    }
  }, []);

  // Home never keeps a game connection: close the one left over from the last room whenever home is focused
  useFocusEffect(
    useCallback(() => {
      if (socket) {
        endSocket();
      }
    }, [socket, endSocket])
  );

  // An invite link opened without a name (the waiting room sent us here): once the home form shows (after the
  // first-run screen, if any), open the join panel with the link's code, asking for the name there too. On focus
  // only: on a cold start the stack keeps a hidden home under the waiting room.
  const showsHomeForm = !isLoading && hasSeenInitialScreen;
  useFocusEffect(
    useCallback(() => {
      if (!showsHomeForm || !pendingInviteCode) return;
      setPendingInviteCode(null);
      setJoinCodeDraft(pendingInviteCode);
      setAskNameToJoin(true);
      setIsJoiningGame(true);
    }, [showsHomeForm, pendingInviteCode])
  );

  // When the join panel closes, the home form comes back: the name bounces up and Join game bounces down
  useEffect(() => {
    if (!isJoiningGame && !isFirstMount) {
      setShouldAnimateCreateGameButton(true);
      usernameInputRef.current?.animate(REAPPEAR_BOUNCE_UP, HOME_ANIMATION_MS);
      JoingameButtonRef.current?.animate(REAPPEAR_BOUNCE_DOWN, HOME_ANIMATION_MS);
    }
    if (isFirstMount) {
      setIsFirstMount(false);
    }
  }, [isJoiningGame]);

  // Android back: closes the keyboard, then the join panel
  useBackHandler(() =>
    handleHomeBackPress({ keyboard: Keyboard, isJoiningGame, cancelJoin: handleCancelJoinGame })
  );

  // Name typed (or cleared): kept in the game context and saved for the next launch
  const handleUsernameChange = async (text: string) => {
    setUsername(text);
    await AsyncStorage.setItem(USERNAME_STORAGE_KEY, text);
  };

  /**
   * Saves the typed name without stray spaces before Create / Join (normalized here, not while typing, so the space
   * between two words can still be typed). False, with the input shaken, when the name is blank.
   */
  const submitUsername = (): boolean => {
    const name = normalizeUsername(username);
    if (!name) {
      usernameInputRef.current?.shake?.(SHAKE_MS);
      return false;
    }
    if (name !== username) handleUsernameChange(name);
    return true;
  };

  // Join game: opens the join panel
  const handleJoinGame = () => {
    if (!submitUsername()) return;

    setIsJoiningGame(true);
  };

  // Create game: the waiting room asks the server for a new room
  const handleCreateGame = async () => {
    if (!submitUsername()) return;

    if (!(await ensureGalleryAccess())) return;

    requestNewRoom();
    router.push("/screens/WaitingRoom");
  };

  // Search room: joins the typed room through the waiting room
  const handleSearchRoom = async () => {
    // Already checked by Join game, unless the panel asks for the name itself
    if (!submitUsername()) return;

    if (!isRoomCode(joinCodeDraft)) {
      gameCodeAnimRef.current?.shake?.(SHAKE_MS);
      return;
    }

    if (!(await ensureGalleryAccess())) return;

    // The typed code stays in the panel: a refused join comes back to home with it
    setGameCode(joinCodeDraft);
    router.push("/screens/WaitingRoom");
  };

  // Leave for the photo explorer with an exit animation; the elements come back when home is focused again
  const navigateWithExit = useExitAnimationNavigation([
    { ref: buttonRef, exit: "slideOutDownFar", enter: "slideInUp" },
    { ref: textRef, exit: "slideOutDownFar", enter: "slideInUp" },
    { ref: usernameInputRef, exit: "fadeOut", enter: "fadeIn" },
    { ref: createGameButtonRef, exit: "fadeOut", enter: "fadeIn" },
    { ref: JoingameButtonRef, exit: "fadeOut", enter: "fadeIn" },
    { ref: topLogoRef, exit: "slideOutUpFar", enter: "slideInDownFar" },
  ]);
  // Both the dice button and its "Photo Explorer" label open it
  const openPhotoExplorer = () => navigateWithExit("/screens/OwnPhotos");

  // Closes the join panel (tap outside it, or Android back); the home form animates back in (effect above)
  const handleCancelJoinGame = () => {
    setIsJoiningGame(false);
    setAskNameToJoin(false);
    setShouldAnimateCreateGameButton(true);
  };

  /** The name field with its clear button: on the home form, and in the join panel when it asks for the name */
  const renderUsernameInput = (animation: string | undefined) => (
    <Animatable.View
      ref={usernameInputRef}
      animation={animation}
      duration={HOME_ANIMATION_MS}
      style={tw`w-full flex items-center justify-center mb-4 relative`}
    >
      <TextInput
        testID={TEST_IDS.usernameInput}
        accessibilityLabel={t.enterUsername}
        style={tw`h-15 rounded-2xl  w-full bg-white font-bold text-center text-lg`}
        placeholder={t.enterUsername}
        placeholderTextColor="#3333"
        value={username || ""}
        onChange={(e) => handleUsernameChange(e.nativeEvent.text)}
        maxLength={MAX_USERNAME_INPUT_LENGTH}
      />
      {username && username.length > 0 && (
        <View style={tw`absolute flex items-center justify-center h-full absolute right-4`}>
          <TouchableOpacity
            testID={TEST_IDS.usernameClearButton}
            accessibilityRole="button"
            accessibilityLabel={t.clearUsername}
            style={tw` justify-center  bg-gray-200 h-8 w-8 rounded-full flex items-center justify-center`}
            onPress={() => {
              handleUsernameChange("");
              Keyboard.dismiss();
            }}
          >
            <Ionicons name="close-outline" size={24} color="black" />
          </TouchableOpacity>
        </View>
      )}
    </Animatable.View>
  );

  // Spinner while the initial data loads
  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  // First run: the welcome screen that asks for photo access
  if (!hasSeenInitialScreen) {
    return <InitialScreen />;
  }

  return (
    <>
      <View style={tw`absolute w-full h-full bg-black`}>
        <StatusBar hidden />
        {/* Blurred background: one image, no layout/measure round trips (EXP-262) */}
        <Image source={backgroundImage} blurRadius={BACKDROP_BLUR_RADIUS} resizeMode="cover" style={tw`w-full h-full`} />
      </View>
      <View style={tw`flex-1 justify-center items-center `}>
        {/* Language toggle */}
        <View style={[tw`absolute left-4 z-20`, { top: HOME_TOP_ROW_TOP }]}>
          <LanguageToggle />
        </View>
        {/* Only part of the gallery shared: same row as the language toggle, clear of the form and Photo Explorer */}
        <View
          style={[
            tw`absolute left-20 right-4 z-20 justify-center items-end`,
            { top: HOME_TOP_ROW_TOP, minHeight: HOME_TOP_ROW_HEIGHT },
          ]}
          pointerEvents="box-none"
        >
          <View onLayout={handleBannerLayout}>
            <LimitedAccessBanner />
          </View>
        </View>

        {/* Logo at the top */}
        <Animatable.View
          ref={topLogoRef}
          animation="slideInDown"
          duration={HOME_ANIMATION_MS}
          style={tw`absolute top-[10%]`}
          onLayout={handleLogoLayout}
        >
          <View style={[tw` flex-1 items-center  max-w-[300px] w-[100%]`, { height: LOGO_BOX_HEIGHT }]}>
            <Text
              style={[
                tw`text-white ${getTitleFontSize()}  z-10 text-center pt-15`,
                { fontFamily: BRAND_DISPLAY_FONT },
                BRAND_LOGO_SHADOW,
              ]}
            >
              {t.appName}
            </Text>
            <Image
              source={require("@/assets/images/carasonrojada.png")}
              style={[
                tw` z-4 right-[-20] absolute`,
                { top: LOGO_EMOJI_TOP, width: LOGO_EMOJI_BOX_PERCENT, height: LOGO_EMOJI_BOX_PERCENT },
                // Shrinks towards its bottom edge to clear the limited-access banner (EXP-281)
                emojiScale < 1 && { transform: [{ scale: emojiScale }], transformOrigin: "bottom" },
              ]}
              resizeMode="contain"
            />
          </View>
        </Animatable.View>

        <View style={tw`px-2 flex-1 w-full max-w-[500px] self-center justify-center pt-[18%] items-center`}>
          {/* Home form: name, Create game and Join game */}
          {!isJoiningGame && (
            <>
              {renderUsernameInput(shouldAnimateCreateGameButton ? "fadeIn" : undefined)}

              <Animatable.View
                ref={createGameButtonRef}
                animation={shouldAnimateCreateGameButton ? "fadeIn" : undefined}
                duration={HOME_ANIMATION_MS}
                style={tw`w-full`}
              >
                <BrandButton testID={TEST_IDS.createGameButton} label={t.createGame} onPress={handleCreateGame} />
              </Animatable.View>

              <Animatable.View
                ref={JoingameButtonRef}
                animation={shouldAnimateCreateGameButton ? "fadeIn" : undefined}
                duration={HOME_ANIMATION_MS}
                style={tw`w-full`}
              >
                <BrandButton testID={TEST_IDS.joinGameButton} label={t.joinGame} onPress={handleJoinGame} />
              </Animatable.View>
            </>
          )}

          {/* Join panel: room code (and the name, for an invite) and Search room; tapping outside closes it */}
          {isJoiningGame && (
            <TouchableWithoutFeedback accessible={false} onPress={handleCancelJoinGame}>
              <View style={tw`flex-1 w-full justify-center items-center`}>
                {askNameToJoin && renderUsernameInput("slideInDownBounce")}
                {/* Room code input */}
                <Animatable.View
                  ref={gameCodeAnimRef}
                  animation="slideInDownBounce"
                  duration={HOME_ANIMATION_MS}
                  style={tw`w-full mb-4 relative`}
                >
                  <TextInput
                    ref={gameCodeInputRef}
                    testID={TEST_IDS.gameCodeInput}
                    accessibilityLabel={t.enterGameCode}
                    style={tw`p-4 rounded-xl  w-full bg-white text-center text-lg font-bold`}
                    placeholder={t.enterGameCode}
                    placeholderTextColor="#3333"
                    value={joinCodeDraft}
                    onChangeText={(text) => setJoinCodeDraft(sanitizeRoomCodeInput(text))}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    autoComplete="off"
                    spellCheck={false}
                    // No maxLength: it would cut a pasted " K7MQ4X" before sanitizing; sanitizing keeps 6 characters
                  />
                  {joinCodeDraft.length > 0 && (
                    <View style={tw`absolute right-4 h-full flex justify-center items-center`}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={t.clearGameCode}
                        style={tw`  bg-gray-200 h-8 w-8 rounded-full flex items-center justify-center`}
                        onPress={() => {
                          setJoinCodeDraft("");
                          Keyboard.dismiss();
                        }}
                      >
                        <Ionicons name="close-outline" size={24} color="black" />
                      </TouchableOpacity>
                    </View>
                  )}
                </Animatable.View>

                <Animatable.View animation="slideInUpBounce" duration={HOME_ANIMATION_MS} style={tw`w-full`}>
                  <BrandButton testID={TEST_IDS.searchRoomButton} label={t.searchRoom} onPress={handleSearchRoom} />
                </Animatable.View>
              </View>
            </TouchableWithoutFeedback>
          )}
        </View>
        {/* Photo explorer button */}
        <Animatable.View ref={buttonRef} animation="slideInUp" duration={HOME_ANIMATION_MS} style={tw`absolute bottom-22 items-center`}>
          <TouchableOpacity
            testID={TEST_IDS.ownPhotosButton}
            accessibilityRole="button"
            accessibilityLabel={t.photoExplorer}
            style={tw`bg-white/50 p-3  rounded-3xl`}
            onPress={openPhotoExplorer}
          >
            <Ionicons name="dice" size={44} color="white" />
          </TouchableOpacity>
        </Animatable.View>
        <Animatable.View ref={textRef} animation="slideInUp" duration={HOME_ANIMATION_MS} style={tw`absolute bottom-15`}>
          {/* Tappable for sighted users; hidden from screen readers, which already get the dice button (EXP-283) */}
          <TouchableOpacity accessible={false} aria-hidden onPress={openPhotoExplorer}>
            <Text style={tw`text-white font-bold`}>{t.photoExplorer}</Text>
          </TouchableOpacity>
        </Animatable.View>
      </View>
      <GalleryAccessModal
        access={galleryGuard.blocked}
        onAllow={() => galleryGuard.check({ ask: true })}
        onSelectPhotos={galleryGuard.selectMore}
        onRetry={() => galleryGuard.check({ ask: false })}
        onBack={galleryGuard.dismiss}
        onShowHelp={() => {
          galleryGuard.dismiss();
          router.push("/screens/SettingsInstructionsScreen");
        }}
      />
    </>
  );
};

export default Index;
