import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
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
  Animated,
} from "react-native";
import tw from "twrnc";
import { useRouter } from "expo-router";
import InitialScreen from "@/app/screens/InitialScreen";
import { useTermsAccepted } from "@/src/hooks/useTermsAccepted";
import { useGameContext } from "@/src/providers/GameContext";
import { StatusBar } from "react-native";
import * as Animatable from "react-native-animatable";
import { useFocusedBackHandler } from "@/src/hooks/useFocusedBackHandler";
import { useKeyboardPadding } from "@/src/hooks/useKeyboardPadding";
import { useFocusEffect } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useBackgroundContext } from "../src/providers/BackgroundContext";
import { useGalleryAccessGuard } from "@/src/hooks/useGalleryAccessGuard";
import { useExitAnimationNavigation } from "@/src/hooks/useExitAnimationNavigation";
import GalleryAccessModal from "@/src/components/modals/GalleryAccessModal";
import { Ionicons } from "@expo/vector-icons";
import { useI18n } from "../src/i18n";
import LanguageToggle from "../src/components/LanguageToggle";
import LimitedAccessBanner from "../src/components/LimitedAccessBanner";
import BrandButton from "../src/components/BrandButton";
import { BRAND_DISPLAY_FONT, BRAND_LOGO_SHADOW } from "../src/theme/brand";
import {
  HOME_ANIMATION_MS,
  REAPPEAR_BOUNCE_DOWN,
  REAPPEAR_BOUNCE_UP,
  registerHomeAnimations,
  SHAKE_MS,
} from "../src/theme/homeAnimations";
import { TEST_IDS } from "../src/utils/testIds";
import { handleHomeBackPress } from "../src/utils/homeBackPress";
import { isRoomCode, sanitizeRoomCodeInput } from "../src/utils/roomCode";
import { translateServerMessage } from "../src/utils/serverMessage";
import { MAX_USERNAME_INPUT_LENGTH } from "../src/utils/protocolLimits";
import { normalizeUsername } from "../src/utils/username";
import { openExternalLink, privacyPolicyUrl } from "../src/utils/legalLinks";
import {
  HOME_TOP_ROW_HEIGHT,
  HOME_TOP_ROW_TOP,
  LOGO_BOX_HEIGHT,
  LOGO_EMOJI_BOX_PERCENT,
  LOGO_EMOJI_TOP,
  logoEmojiScale,
  PHOTO_EXPLORER_BUTTON_BOTTOM,
  PHOTO_EXPLORER_ICON_SIZE,
  PHOTO_EXPLORER_LABEL_BOTTOM,
  PRIVACY_LINK_BOTTOM,
  PRIVACY_LINK_HIT_SLOP,
  PRIVACY_LINK_MAX_FONT_SCALE,
  PRIVACY_LINK_MAX_LINES,
  privacyLinkMaxWidth,
} from "../src/utils/homeLayout";

SplashScreen.preventAutoHideAsync();

/** How much the home background photo is blurred */
const BACKDROP_BLUR_RADIUS = 3;
/** Keyboard height (pt) at which the top logo has faded out, clearing the way for the raised join panel */
const LOGO_FADED_AT_KEYBOARD_HEIGHT = 150;

registerHomeAnimations();

const Index = () => {
  const router = useRouter();
  // Initial data: whether this device accepted the current terms (undefined while it is read). The saved name is
  // loaded by GameProvider at app start.
  const [termsAccepted, refreshTermsAccepted] = useTermsAccepted();
  const {
    saveUsername,
    username,
    setGameCode,
    joinCodeDraft,
    setJoinCodeDraft,
    socket,
    endSocket,
    requestNewRoom,
    takeHomeNotice,
    takeRoomExit,
  } = useGameContext();
  const { backgroundImage } = useBackgroundContext();
  const [isJoiningGame, setIsJoiningGame] = useState(false);
  const [shouldAnimateCreateGameButton, setShouldAnimateCreateGameButton] = useState(false);
  const [isFirstMount, setIsFirstMount] = useState(true);
  const usernameInputRef = useRef<Animatable.View & View>(null);
  const gameCodeAnimRef = useRef<Animatable.View & View>(null);
  const createGameButtonRef = useRef<Animatable.View & View>(null);
  const JoingameButtonRef = useRef<Animatable.View & View>(null);
  const buttonRef = useRef<Animatable.View & View>(null);
  const textRef = useRef<Animatable.View & View>(null);
  const topLogoRef = useRef<Animatable.View & View>(null);
  const privacyLinkRef = useRef<Animatable.View & View>(null);
  const { t, lang } = useI18n();
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
  // The privacy link fits beside the Photo Explorer label, as laid out (null = not yet: the link waits for it)
  const [photoExplorerLabelWidth, setPhotoExplorerLabelWidth] = useState<number | null>(null);
  const handlePhotoExplorerLabelLayout = (e: LayoutChangeEvent) => setPhotoExplorerLabelWidth(e.nativeEvent.layout.width);
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

  // The terms may be accepted elsewhere while this home waits under another screen (a cold-start invite link's dialog,
  // EXP-433): read again when it is focused, so it doesn't show the first-run screen once they are
  useFocusEffect(
    useCallback(() => {
      if (termsAccepted === false) refreshTermsAccepted();
    }, [termsAccepted, refreshTermsAccepted])
  );

  // The server's reason for sending us home (room-of-game refusal, connection refused, kicked), in our language: the
  // screens over home hand it over in memory (useGoHome) as they pop back to it, and it is shown once. Never read from
  // the route's params, which any link could set.
  useFocusEffect(
    useCallback(() => {
      const notice = takeHomeNotice();
      if (notice) Alert.alert(t.serverNoticeTitle, translateServerMessage(notice, t), [{ text: t.ok }]);
    }, [takeHomeNotice, t])
  );

  // Home never keeps a game connection, but only a room screen's own way out (useGoHome) leaves its room: then home
  // closes the connection it left over. Reached any other way while in a room (a link to "/" pushes another home over
  // the lobby or the game, EXP-373), home gives way to that room's screen, which keeps its room. With no room screen
  // under it, nothing can use the connection any more: closed too. Once per focus (and socket): the context's
  // functions are stable in what they do (they only touch refs and state setters).
  useFocusEffect(
    useCallback(() => {
      const leftRoom = takeRoomExit();
      if (!socket) return;
      if (leftRoom || !router.canGoBack()) endSocket();
      else router.back();
    }, [socket])
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

  // Android back and a tap outside the join panel's field and button: close the keyboard first (the room code field
  // opens with it, EXP-378), then the join panel
  const closeKeyboardThenJoinPanel = () =>
    handleHomeBackPress({ keyboard: Keyboard, isJoiningGame, cancelJoin: handleCancelJoinGame });
  // Only while home is focused: under the waiting room it would take the press meant for its Exit (EXP-339)
  useFocusedBackHandler(closeKeyboardThenJoinPanel);

  // Leaving home (Search room, an invite link opening the lobby over it, the photo explorer) closes its keyboard: a
  // field left focused under the next screen would keep it up there
  useFocusEffect(useCallback(() => () => Keyboard.dismiss(), []));

  // The window doesn't shrink for the keyboard: the join panel rises above it so Search room stays visible, and the
  // logo fades out as the keyboard comes up, so on short screens the raised panel doesn't cover half of it
  const keyboardPadding = useKeyboardPadding();
  const logoOpacity = useMemo(
    () =>
      keyboardPadding.interpolate({
        inputRange: [0, LOGO_FADED_AT_KEYBOARD_HEIGHT],
        outputRange: [1, 0],
        extrapolate: "clamp",
      }),
    [keyboardPadding]
  );

  // Name typed (or cleared): kept in the game context and saved for the next launch
  const handleUsernameChange = (text: string) => saveUsername(text);

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

  // Search room (button or the keyboard's Go): joins the typed room through the waiting room
  const handleSearchRoom = async () => {
    // The name was already checked (and saved normalized) by Join game, which opened this panel
    if (!isRoomCode(joinCodeDraft)) {
      // The keyboard stays up to fix the code
      gameCodeAnimRef.current?.shake?.(SHAKE_MS);
      return;
    }
    // Not over the gallery access modal nor the waiting room
    Keyboard.dismiss();

    if (!(await ensureGalleryAccess())) return;

    // The typed code stays in the panel: a refused join comes back to home with it
    setGameCode(joinCodeDraft);
    closeJoinPanelOnReturnRef.current = true;
    router.push("/screens/WaitingRoom");
  };

  // The join panel is done once Search room opens the lobby: when the room gives way back to this same home (it pops to
  // it, EXP-339), home's form comes back as it does when the panel closes; the typed code stays in the panel
  const closeJoinPanelOnReturnRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!closeJoinPanelOnReturnRef.current) return;
      closeJoinPanelOnReturnRef.current = false;
      handleCancelJoinGame();
    }, [])
  );

  // Leave for the photo explorer with an exit animation; the elements come back when home is focused again
  const navigateWithExit = useExitAnimationNavigation([
    { ref: buttonRef, exit: "slideOutDownFar", enter: "slideInUp" },
    { ref: textRef, exit: "slideOutDownFar", enter: "slideInUp" },
    { ref: usernameInputRef, exit: "fadeOut", enter: "fadeIn" },
    { ref: createGameButtonRef, exit: "fadeOut", enter: "fadeIn" },
    { ref: JoingameButtonRef, exit: "fadeOut", enter: "fadeIn" },
    { ref: topLogoRef, exit: "slideOutUpFar", enter: "slideInDownFar" },
    { ref: privacyLinkRef, exit: "fadeOut", enter: "fadeIn" },
  ]);
  // Both the dice button and its "Photo Explorer" label open it
  const openPhotoExplorer = () => navigateWithExit("/screens/OwnPhotos");

  // The privacy policy opens in the browser (EXP-426): an external page, not a route
  const openPrivacyPolicy = () => openExternalLink(privacyPolicyUrl(lang));

  // Closes the join panel (tap outside it, or Android back); the home form animates back in (effect above)
  const handleCancelJoinGame = () => {
    setIsJoiningGame(false);
    setShouldAnimateCreateGameButton(true);
  };

  /** The home form's name field with its clear button (which keeps the keyboard up, to type the new name) */
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
            onPress={() => handleUsernameChange("")}
          >
            <Ionicons name="close-outline" size={24} color="black" />
          </TouchableOpacity>
        </View>
      )}
    </Animatable.View>
  );

  // Spinner while the initial data loads
  if (termsAccepted === undefined) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  // First run, or terms changed since they were accepted: the welcome screen that asks to accept the terms and for
  // photo access
  if (!termsAccepted) {
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
        {/* The keyboard fade is on a wrapper: the Animatable view's own animations (slide in, exit) drive its style */}
        <Animated.View
          testID={TEST_IDS.homeLogo}
          style={[tw`absolute top-[10%]`, { opacity: logoOpacity }]}
          onLayout={handleLogoLayout}
        >
          <Animatable.View ref={topLogoRef} animation="slideInDown" duration={HOME_ANIMATION_MS}>
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
        </Animated.View>

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

          {/* Join panel: room code and Search room; tapping outside closes the keyboard, then the panel */}
          {isJoiningGame && (
            <TouchableWithoutFeedback accessible={false} onPress={closeKeyboardThenJoinPanel}>
              <Animated.View
                testID={TEST_IDS.joinPanel}
                style={[tw`flex-1 w-full justify-center items-center`, { paddingBottom: keyboardPadding }]}
              >
                {/* Room code input */}
                <Animatable.View
                  ref={gameCodeAnimRef}
                  animation="slideInDownBounce"
                  duration={HOME_ANIMATION_MS}
                  style={tw`w-full mb-4 relative`}
                >
                  <TextInput
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
                    // Opens ready to type; the keyboard's Go searches the room (a wrong code keeps the keyboard up)
                    autoFocus
                    returnKeyType="go"
                    submitBehavior="submit"
                    onSubmitEditing={handleSearchRoom}
                    // No maxLength: it would cut a pasted " K7MQ4X" before sanitizing; sanitizing keeps 6 characters
                  />
                  {/* Clears the code, keeping the keyboard up to type the right one */}
                  {joinCodeDraft.length > 0 && (
                    <View style={tw`absolute right-4 h-full flex justify-center items-center`}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={t.clearGameCode}
                        style={tw`  bg-gray-200 h-8 w-8 rounded-full flex items-center justify-center`}
                        onPress={() => setJoinCodeDraft("")}
                      >
                        <Ionicons name="close-outline" size={24} color="black" />
                      </TouchableOpacity>
                    </View>
                  )}
                </Animatable.View>

                <Animatable.View animation="slideInUpBounce" duration={HOME_ANIMATION_MS} style={tw`w-full`}>
                  <BrandButton testID={TEST_IDS.searchRoomButton} label={t.searchRoom} onPress={handleSearchRoom} />
                </Animatable.View>
              </Animated.View>
            </TouchableWithoutFeedback>
          )}
        </View>
        {/* Photo explorer button */}
        <Animatable.View
          ref={buttonRef}
          animation="slideInUp"
          duration={HOME_ANIMATION_MS}
          style={[tw`absolute items-center`, { bottom: PHOTO_EXPLORER_BUTTON_BOTTOM }]}
        >
          <TouchableOpacity
            testID={TEST_IDS.ownPhotosButton}
            accessibilityRole="button"
            accessibilityLabel={t.photoExplorer}
            style={tw`bg-white/50 p-3  rounded-3xl`}
            onPress={openPhotoExplorer}
          >
            <Ionicons name="dice" size={PHOTO_EXPLORER_ICON_SIZE} color="white" />
          </TouchableOpacity>
        </Animatable.View>
        <Animatable.View
          ref={textRef}
          animation="slideInUp"
          duration={HOME_ANIMATION_MS}
          style={[tw`absolute`, { bottom: PHOTO_EXPLORER_LABEL_BOTTOM }]}
        >
          {/* Tappable for sighted users; hidden from screen readers, which already get the dice button (EXP-283) */}
          <TouchableOpacity accessible={false} aria-hidden onPress={openPhotoExplorer} onLayout={handlePhotoExplorerLabelLayout}>
            <Text style={tw`text-white font-bold`}>{t.photoExplorer}</Text>
          </TouchableOpacity>
        </Animatable.View>
        {/* Privacy policy: a small link on the Photo Explorer label's row, in the strip right of it */}
        <Animatable.View ref={privacyLinkRef} style={[tw`absolute right-2`, { bottom: PRIVACY_LINK_BOTTOM }]}>
          {photoExplorerLabelWidth !== null && (
            <TouchableOpacity
              testID={TEST_IDS.homePrivacyLink}
              accessibilityRole="link"
              accessibilityLabel={t.privacyPolicy}
              style={[tw`py-1`, { maxWidth: privacyLinkMaxWidth(width, photoExplorerLabelWidth) }]}
              hitSlop={PRIVACY_LINK_HIT_SLOP}
              onPress={openPrivacyPolicy}
            >
              <Text
                style={tw`text-white/70 text-xs text-right underline`}
                numberOfLines={PRIVACY_LINK_MAX_LINES}
                maxFontSizeMultiplier={PRIVACY_LINK_MAX_FONT_SCALE}
              >
                {t.privacy}
              </Text>
            </TouchableOpacity>
          )}
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
