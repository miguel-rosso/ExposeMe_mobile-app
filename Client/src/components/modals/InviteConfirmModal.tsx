import React, { useRef, useState } from "react";
import { Animated, Text, TextInput, TouchableOpacity, View } from "react-native";
import tw from "twrnc";
import { useI18n } from "@/src/i18n";
import { useKeyboardPadding } from "@/src/hooks/useKeyboardPadding";
import { TEST_IDS } from "@/src/utils/testIds";
import { MAX_USERNAME_INPUT_LENGTH } from "@/src/utils/protocolLimits";
import { normalizeUsername } from "@/src/utils/username";
import { recordTermsAccepted } from "@/src/utils/termsAcceptance";
import { useTermsAccepted } from "@/src/hooks/useTermsAccepted";
import TermsConsent from "@/src/components/TermsConsent";

interface InviteConfirmModalProps {
  /** Room the invite link points to */
  roomCode: string;
  /** Name saved on this device, shown in the editable field ("" when there is none) */
  initialName: string;
  /** Join: called with the typed name normalized (never blank); Join stays disabled until it settles */
  onJoin: (name: string) => Promise<void>;
  /** Don't join: back to the room the player is in, or home when there is none */
  onCancel: () => void;
}

/**
 * Asked when an invite link opens the waiting room (DEC-046): nothing joins until the player taps Join, with the
 * saved name filled in and editable. An overlay like AlertModal, above the lobby's loading screen.
 */
const InviteConfirmModal: React.FC<InviteConfirmModalProps> = ({ roomCode, initialName, onJoin, onCancel }) => {
  const { t } = useI18n();
  // Keeps the name field and the buttons above the keyboard (it opens at once when there is no saved name)
  const keyboardPadding = useKeyboardPadding();
  const [name, setName] = useState(initialName);
  const [joining, setJoining] = useState(false);
  // A second tap before the state update renders must not join twice
  const joiningRef = useRef(false);
  // An invite link that cold-starts the app skips the first screen, where the terms are accepted (EXP-433): a device
  // that never accepted the current ones accepts them here, with Join. Join waits until that is known.
  const [termsAccepted] = useTermsAccepted();
  const asksForTerms = termsAccepted === false;
  const normalizedName = normalizeUsername(name);
  const canJoin = normalizedName !== "" && !joining && termsAccepted !== undefined;

  const join = async () => {
    if (!normalizedName || termsAccepted === undefined || joiningRef.current) return;
    joiningRef.current = true;
    setJoining(true);
    try {
      if (asksForTerms) await recordTermsAccepted();
      await onJoin(normalizedName);
    } finally {
      joiningRef.current = false;
      setJoining(false);
    }
  };

  return (
    <View
      testID={TEST_IDS.inviteConfirmModal}
      accessibilityViewIsModal
      style={tw`absolute top-0 left-0 right-0 bottom-0 z-60 bg-black bg-opacity-70`}
    >
      <Animated.View style={[tw`flex-1 justify-center items-center`, { paddingBottom: keyboardPadding }]}>
        <View style={tw`rounded-2xl p-6 bg-gray-800 w-4/5 max-w-[500px]`}>
          <Text accessibilityRole="header" style={tw`text-2xl text-white font-bold text-center mb-1`}>
            {t.inviteJoinTitle}
          </Text>
          <Text testID={TEST_IDS.inviteRoomCode} style={tw`text-4xl text-white font-extrabold text-center mb-5`}>
            {roomCode}
          </Text>
          <Text style={tw`text-white text-sm opacity-70 mb-2`}>{t.inviteNameLabel}</Text>
          <TextInput
            testID={TEST_IDS.inviteNameInput}
            accessibilityLabel={t.inviteNameLabel}
            value={name}
            onChangeText={setName}
            placeholder={t.enterUsername}
            placeholderTextColor="#3333"
            maxLength={MAX_USERNAME_INPUT_LENGTH}
            autoFocus={!initialName}
            autoCorrect={false}
            // The keyboard's return only closes it: joining is always the explicit Join
            returnKeyType="done"
            style={tw`h-14 rounded-xl bg-white font-bold text-center text-lg mb-5`}
          />
          {asksForTerms && (
            <View style={tw`mb-4`}>
              <TermsConsent />
            </View>
          )}
          <View style={tw`flex-row`}>
            <TouchableOpacity
              testID={TEST_IDS.inviteCancelButton}
              accessibilityRole="button"
              accessibilityLabel={t.cancel}
              onPress={onCancel}
              style={tw`flex-1 bg-gray-600 py-3 rounded-xl mr-2`}
            >
              <Text style={tw`text-white text-lg font-bold text-center`}>{t.cancel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID={TEST_IDS.inviteJoinButton}
              accessibilityRole="button"
              accessibilityLabel={t.inviteJoin}
              accessibilityState={{ disabled: !canJoin }}
              disabled={!canJoin}
              onPress={join}
              style={tw`flex-1 py-3 rounded-xl ml-2 ${canJoin ? "bg-[#e9042e]" : "bg-gray-500"}`}
            >
              <Text style={tw`text-white text-lg font-bold text-center`}>{t.inviteJoin}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Animated.View>
    </View>
  );
};

export default InviteConfirmModal;
