import React from "react";
import { TouchableOpacity, Text } from "react-native";
import tw from "twrnc";
import { useI18n } from "../i18n";
import { TEST_IDS } from "../utils/testIds";

const LanguageToggle = () => {
  const { t, lang, setLang } = useI18n();

  return (
    <TouchableOpacity
      testID={TEST_IDS.languageToggle}
      accessibilityRole="button"
      accessibilityLabel={t.changeLanguage}
      onPress={() => setLang(lang === "es" ? "en" : "es")}
      style={tw`bg-white/15 px-3 py-1.5 rounded-full`}
    >
      <Text style={tw`text-xl`}>
        {lang === "es" ? "🇪🇸" : "🇺🇸"}
      </Text>
    </TouchableOpacity>
  );
};

export default LanguageToggle;
