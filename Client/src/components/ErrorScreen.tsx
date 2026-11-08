import React, { useEffect } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { useRoute, type ErrorBoundaryProps } from "expo-router";
import tw from "twrnc";
import { deviceTranslations, useI18n } from "@/src/i18n";
import type { Translations } from "@/src/i18n/context";
import { useGameContext } from "@/src/providers/GameContext";
import { useFocusedBackHandler } from "@/src/hooks/useFocusedBackHandler";
import { useGoHome } from "@/src/hooks/useGoHome";
import { useRouteBelow } from "@/src/hooks/useRouteBelow";
import { TEST_IDS } from "@/src/utils/testIds";
import { forgetScreenRetry, markScreenRetry } from "@/src/utils/screenRetry";

// A render error that reaches no error boundary closes the app in a store build (EXP-435). expo-router catches it
// with these: ScreenErrorBoundary in place of the screen that failed (the root stack's unstable_screenErrorBoundary,
// inside every provider), AppErrorBoundary in place of the whole app when the root layout or a provider fails.

interface ErrorScreenProps {
  error: Error;
  t: Translations;
  onRetry: () => void;
  /** None where there is no app left to go home in (the root fallback) */
  onGoHome?: () => void;
}

/** Says that something failed, with a way to render it again and, if given, a way back home. */
const ErrorScreen = ({ error, t, onRetry, onGoHome }: ErrorScreenProps) => {
  // console.error is kept in production builds (babel.config.js strips only log, info and debug)
  useEffect(() => {
    console.error("Render error caught by the error screen:", error);
  }, [error]);

  const button = (testID: string, label: string, onPress: () => void, color: string) => (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={tw`${color} px-4 py-3 rounded-xl mt-3 w-full`}
    >
      <Text style={tw`text-white text-base font-bold text-center`}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View testID={TEST_IDS.errorScreen} style={tw`flex-1 justify-center items-center bg-black px-8`}>
      <View style={tw`w-full max-w-[500px] items-center`}>
        <Text accessibilityRole="alert" style={tw`text-white text-2xl font-bold text-center`}>
          {t.errorScreenTitle}
        </Text>
        <Text style={tw`text-gray-300 text-base text-center mt-2 mb-4`}>{t.errorScreenMessage}</Text>
        {button(TEST_IDS.errorScreenRetry, t.tryAgain, onRetry, "bg-blue-600")}
        {onGoHome && button(TEST_IDS.errorScreenHome, t.errorScreenHome, onGoHome, "bg-gray-700")}
      </View>
    </View>
  );
};

/**
 * In place of a screen that failed to render. Back home leaves the room first (leave-room, as the screen's Exit), so the
 * others are not left waiting for a lost connection. Home is the bottom screen: if it is the one that failed, going
 * home is rendering it again. Android back is Back to home too: the failed screen's own back handler is gone with it,
 * and a plain pop would reach home without a leave (home then just closes the socket: a lost connection for the others).
 * Retry is marked for the screen it renders again (utils/screenRetry), so that mount knows it is a retry.
 */
export const ScreenErrorBoundary = ({ error, retry }: ErrorBoundaryProps) => {
  const { t } = useI18n();
  const { socket, leaveRoom } = useGameContext();
  const goHome = useGoHome();
  const routeBelow = useRouteBelow();
  const { name: routeName } = useRoute();

  // Shown again: a retry still pending failed too, it is no retry of whatever mounts next
  useEffect(() => { forgetScreenRetry(); }, []);
  const retryScreen = () => {
    markScreenRetry(routeName);
    void retry();
  };

  const isHome = () => routeBelow() === null;
  const leaveToHome = () => {
    // No socket, no room: a leave would only forget the stored rejoin token
    if (socket) leaveRoom();
    if (isHome()) void retry();
    else goHome();
  };

  // On home, back still leaves the app
  useFocusedBackHandler(() => {
    if (isHome()) return false;
    leaveToHome();
    return true;
  });

  return <ErrorScreen error={error} t={t} onRetry={retryScreen} onGoHome={leaveToHome} />;
};

/** In place of the whole app (root layout or a provider failed): outside I18nProvider, so in the device language. */
export const AppErrorBoundary = ({ error, retry }: ErrorBoundaryProps) => (
  <ErrorScreen error={error} t={deviceTranslations()} onRetry={() => void retry()} />
);
