import React, { useEffect, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import Icon from "react-native-vector-icons/FontAwesome";
import tw from "twrnc";
import { useI18n } from "../i18n";
import { TEST_IDS } from "../utils/testIds";

/** How long the "couldn't upload" notice stays under the button after the planted photo's upload gives up. */
export const PLANT_FAILED_NOTICE_MS = 3000;

interface PlantPhotoButtonProps {
  /** The server has a planted photo of mine. */
  planted: boolean;
  /** The picked photo is being uploaded (with its retries). */
  uploading: boolean;
  /** The picked photo's upload gave up. */
  failed: boolean;
  disabled: boolean;
  onPress: () => void;
}

/** Lobby button to plant a photo: planted / uploading / not planted, and a short notice when an upload gives up. */
const PlantPhotoButton: React.FC<PlantPhotoButtonProps> = ({ planted, uploading, failed, disabled, onPress }) => {
  const { t } = useI18n();
  const [showFailedNotice, setShowFailedNotice] = useState(false);

  useEffect(() => {
    if (!failed) return;
    setShowFailedNotice(true);
    const timer = setTimeout(() => setShowFailedNotice(false), PLANT_FAILED_NOTICE_MS);
    return () => {
      clearTimeout(timer);
      setShowFailedNotice(false);
    };
  }, [failed]);

  const label = planted ? t.photoPlanted : uploading ? t.plantingPhoto : t.plantPhoto;

  return (
    <TouchableOpacity testID={TEST_IDS.plantPhotoButton} onPress={onPress} style={tw`mb-2 items-center`} disabled={disabled}>
      <View
        testID={planted ? TEST_IDS.plantPhotoPlanted : TEST_IDS.plantPhotoNotPlanted}
        style={tw`h-14 w-14 rounded-full ${planted ? "bg-green-600" : "bg-black/40"} flex justify-center items-center`}
      >
        {uploading ? (
          <ActivityIndicator color="white" />
        ) : (
          <Icon name={planted ? "check" : "camera"} size={22} color="white" style={planted ? tw`ml-0.5` : tw``} />
        )}
      </View>
      <Text style={tw`mt-1 text-white font-medium text-center text-xs`}>{label}</Text>
      {showFailedNotice && <Text style={tw`mt-1 text-red-300 font-medium text-center text-xs`}>{t.plantPhotoFailed}</Text>}
    </TouchableOpacity>
  );
};

export default PlantPhotoButton;
