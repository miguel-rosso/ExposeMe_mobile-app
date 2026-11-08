import React from "react";
import { Alert, ScrollView, StatusBar, Text, TouchableOpacity, View } from "react-native";
import tw from "twrnc";
import { useRouter } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../../src/i18n";
import { fillTemplate } from "../../src/i18n/format";
import { TEST_IDS } from "../../src/utils/testIds";
import { HOME_PATH } from "../../src/utils/homeRoute";
import { appVersion } from "../../src/utils/appVersion";
import {
  contactEmail,
  contactMailtoUrl,
  openExternalLink,
  privacyPolicyUrl,
  termsOfUseUrl,
} from "../../src/utils/legalLinks";

// ── Information screen (EXP-434) ──
// Always reachable from home's Info link: the privacy policy and terms of use pages (in the browser), the contact
// address when the build has one (EXPO_PUBLIC_CONTACT_EMAIL) and the app version.

// Gap kept between the Back button and the bottom inset (same as the p-4 padding on the other edges)
const FOOTER_BOTTOM_GAP = 16;

interface LinkRowProps {
  testID: string;
  label: string;
  /** Screen reader name, when it says more than the label */
  accessibilityLabel?: string;
  /** Second line under the label */
  detail?: string;
  onPress: () => void;
  first?: boolean;
}

/** One tappable row of the links card */
const LinkRow: React.FC<LinkRowProps> = ({ testID, label, accessibilityLabel, detail, onPress, first }) => (
  <TouchableOpacity
    testID={testID}
    accessibilityRole="link"
    accessibilityLabel={accessibilityLabel ?? label}
    style={tw`px-4 py-3 ${first ? "" : "border-t border-gray-700"}`}
    onPress={onPress}
    activeOpacity={0.7}
  >
    <Text style={tw`text-base text-gray-100`}>{label}</Text>
    {detail && <Text style={tw`text-sm text-gray-400`}>{detail}</Text>}
  </TouchableOpacity>
);

const InfoScreen: React.FC = () => {
  const { t, lang } = useI18n();
  const router = useRouter();
  // The Back button lives in a fixed footer, padded by the bottom inset (Android gesture bar / iOS home indicator)
  const insets = useSafeAreaInsets();
  // No contact row when the build has no (valid) contact address, no version line without an app config
  const email = contactEmail();
  const version = appVersion();

  // Without a mail app the address is shown instead, so it can still be written to
  const openContact = async (address: string) => {
    if (!(await openExternalLink(contactMailtoUrl(address)))) Alert.alert(t.contactUs, address);
  };

  return (
    <SafeAreaView testID={TEST_IDS.infoScreen} edges={["top", "left", "right"]} style={tw`flex-1 bg-gray-900`}>
      <StatusBar barStyle="light-content" />
      <ScrollView style={tw`flex-1`} contentContainerStyle={tw`flex-grow p-4`} showsVerticalScrollIndicator={false}>
        <View style={tw`flex-1 max-w-[500px] w-full self-center`}>
          <Text accessibilityRole="header" style={tw`text-2xl font-bold text-gray-100 text-center mb-5`}>
            {t.information}
          </Text>

          <View style={tw`bg-gray-800 rounded-xl border border-gray-700 w-full`}>
            <LinkRow
              first
              testID={TEST_IDS.infoPrivacyLink}
              label={t.privacyPolicy}
              onPress={() => openExternalLink(privacyPolicyUrl(lang))}
            />
            <LinkRow
              testID={TEST_IDS.infoTermsLink}
              label={t.termsOfUsePage}
              onPress={() => openExternalLink(termsOfUseUrl(lang))}
            />
            {email && (
              <LinkRow
                testID={TEST_IDS.infoContactLink}
                label={t.contactUs}
                accessibilityLabel={`${t.contactUs}: ${email}`}
                detail={email}
                onPress={() => openContact(email)}
              />
            )}
          </View>

          {version && (
            <Text testID={TEST_IDS.infoVersion} style={tw`text-sm text-gray-400 text-center mt-5`}>
              {fillTemplate(t.appVersion, { version })}
            </Text>
          )}
        </View>
      </ScrollView>

      {/* Back button: fixed footer above the bottom inset */}
      <View style={[tw`px-4 pt-3`, { paddingBottom: insets.bottom + FOOTER_BOTTOM_GAP }]}>
        <TouchableOpacity
          testID={TEST_IDS.infoBackButton}
          style={tw`bg-gray-700 p-4 rounded-xl border border-gray-600 w-full max-w-[500px] self-center`}
          // Pops back to the home that opened it (replace would stack a second home over it: EXP-339)
          onPress={() => router.dismissTo(HOME_PATH)}
          activeOpacity={0.7}
        >
          <Text style={tw`text-gray-200 text-base font-medium text-center`}>{t.back}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

export default InfoScreen;
