import React from "react";
import { Text } from "react-native";
import tw from "twrnc";
import { useI18n } from "../i18n";
import { splitTemplate } from "../i18n/format";
import { openExternalLink, privacyPolicyUrl, termsOfUseUrl } from "../utils/legalLinks";
import { TEST_IDS } from "../utils/testIds";

// ── Terms consent line (EXP-433, DEC-058) ──
// «By continuing you accept the Terms and the Privacy policy», with both pages as links in the sentence. Shown next to
// the first screen's button and, on a device that never accepted the terms, above the invite dialog's Join: their tap
// records the acceptance (utils/termsAcceptance).

interface ConsentLink {
  label: string;
  url: string;
  testID: string;
}

const TermsConsent: React.FC = () => {
  const { t, lang } = useI18n();
  // The placeholders of t.termsConsent
  const links: Record<string, ConsentLink> = {
    terms: { label: t.termsOfUse, url: termsOfUseUrl(lang), testID: TEST_IDS.termsLink },
    privacy: { label: t.privacyPolicy, url: privacyPolicyUrl(lang), testID: TEST_IDS.termsPrivacyLink },
  };

  return (
    <Text testID={TEST_IDS.termsConsent} style={tw`text-[13px] leading-5 text-white/60 text-center`}>
      {splitTemplate(t.termsConsent).map((part, i) => {
        if ("text" in part) return part.text;
        const link = links[part.placeholder];
        if (!link) return `{${part.placeholder}}`;
        return (
          <Text
            key={i}
            testID={link.testID}
            accessibilityRole="link"
            onPress={() => openExternalLink(link.url)}
            style={tw`text-white underline font-semibold`}
          >
            {link.label}
          </Text>
        );
      })}
    </Text>
  );
};

export default TermsConsent;
