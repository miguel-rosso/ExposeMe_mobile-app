import React from "react";
import { TouchableOpacity, Text } from "react-native";
import tw from "twrnc";
import { useI18n } from "../i18n";

const LanguageToggle = () => {
  const { lang, setLang } = useI18n();

  return (
    <TouchableOpacity
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
