import React from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import tw from "twrnc";
import { useI18n } from "@/src/i18n";
import type { Translations } from "@/src/i18n/context";
import { fillTemplate } from "@/src/i18n/format";
import type { ReportFlow } from "@/src/hooks/useContentReport";
import type { MutedNames } from "@/src/hooks/useMutedPlayers";
import { REPORT_REASONS, ReportReason, reportedPlayer } from "@/src/utils/contentReport";
import { reportReasonId, TEST_IDS } from "@/src/utils/testIds";

/** Each reason's label, in the picker's order (REPORT_REASONS) */
const REASON_LABELS: Record<ReportReason, keyof Translations> = {
  sexual: "reportReasonSexual",
  violence: "reportReasonViolence",
  harassment: "reportReasonHarassment",
  other: "reportReasonOther",
};

interface ReportContentModalProps {
  flow: ReportFlow;
  onChoose: (reason: ReportReason) => void;
  onRetry: () => void;
  onClose: () => void;
  /** This device's player, never offered to be muted */
  myUsername: string | null;
  /** Players muted on this device: the thanks offers to mute the reported player only when they aren't yet */
  muted: MutedNames;
  /** Mutes a player on this device (useMutedPlayers' toggle) */
  onMute: (username: string) => void;
}

interface DialogButtonProps {
  testID: string;
  label: string;
  onPress: () => void;
  color?: string;
}

const DialogButton = ({ testID, label, onPress, color = "bg-gray-600" }: DialogButtonProps) => (
  <TouchableOpacity
    testID={testID}
    accessibilityRole="button"
    onPress={onPress}
    style={tw`${color} px-4 py-3 rounded-xl mb-3 w-full`}
  >
    <Text style={tw`text-white text-base font-bold text-center`}>{label}</Text>
  </TouchableOpacity>
);

/**
 * The report dialog (EXP-423): the reason picker, then «Thanks, we'll review it» with an offer to mute the reported
 * player (when this device knows who it is: a photo's owner only once revealed), a refusal that trying again can't
 * change (e.g. my own photo, a message the server no longer has), or the failure with Try again. Its
 * own layer above every overlay of the lobby and the game screen.
 */
const ReportContentModal: React.FC<ReportContentModalProps> = ({
  flow, onChoose, onRetry, onClose, myUsername, muted, onMute,
}) => {
  const { t } = useI18n();
  if (flow.step === "closed") return null;

  const reported = reportedPlayer(flow.target);
  // The player the thanks offers to mute, if any
  const mutable = reported !== undefined && reported !== myUsername && !muted.has(reported) ? reported : null;
  const muteAndClose = (username: string) => {
    onMute(username);
    onClose();
  };

  const body = () => {
    switch (flow.step) {
      case "reasons":
        return (
          <>
            <Text style={tw`text-2xl text-white font-bold text-center mb-5`}>{t.reportTitle}</Text>
            {REPORT_REASONS.map((reason) => (
              <DialogButton
                key={reason}
                testID={reportReasonId(reason)}
                label={t[REASON_LABELS[reason]]}
                onPress={() => onChoose(reason)}
                color="bg-red-600"
              />
            ))}
            <DialogButton testID={TEST_IDS.reportCancelButton} label={t.cancel} onPress={onClose} />
          </>
        );
      case "sending":
        return (
          <View testID={TEST_IDS.reportSending} style={tw`items-center py-4`} accessible accessibilityLabel={t.reportSending}>
            <ActivityIndicator size="large" color="white" />
            <Text style={tw`text-white text-base mt-3`}>{t.reportSending}</Text>
          </View>
        );
      case "sent":
        return (
          <>
            <Text testID={TEST_IDS.reportThanks} style={tw`text-xl text-white font-bold text-center mb-5`}>
              {t.reportThanks}
            </Text>
            {mutable && (
              <DialogButton
                testID={TEST_IDS.reportMuteButton}
                label={fillTemplate(t.mutePlayerNamed, { name: mutable })}
                onPress={() => muteAndClose(mutable)}
                color="bg-[#ff8605]"
              />
            )}
            <DialogButton testID={TEST_IDS.reportCloseButton} label={t.close} onPress={onClose} />
          </>
        );
      case "refused":
        return (
          <>
            <Text testID={TEST_IDS.reportRefused} style={tw`text-xl text-white font-bold text-center mb-5`}>
              {t.reportRefused}
            </Text>
            <DialogButton testID={TEST_IDS.reportCloseButton} label={t.close} onPress={onClose} />
          </>
        );
      case "failed":
        return (
          <>
            <Text testID={TEST_IDS.reportFailed} style={tw`text-xl text-white font-bold text-center mb-5`}>
              {t.reportFailed}
            </Text>
            <DialogButton testID={TEST_IDS.reportRetryButton} label={t.tryAgain} onPress={onRetry} color="bg-blue-600" />
            <DialogButton testID={TEST_IDS.reportCloseButton} label={t.close} onPress={onClose} />
          </>
        );
    }
  };

  return (
    <View
      testID={TEST_IDS.reportModal}
      accessibilityViewIsModal
      style={tw`absolute inset-0 z-110 justify-center items-center bg-black bg-opacity-70`}
    >
      <View style={tw`rounded-lg p-6 bg-gray-800 w-4/5 max-w-[500px] items-center`}>{body()}</View>
    </View>
  );
};

export default ReportContentModal;
