import React from "react";
import { View, Text, TouchableOpacity, Image, Dimensions, Platform, StatusBar, ScrollView } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import tw from "twrnc";
import AudioPermissionIMG from "@/assets/images/audioPermissionIMG.jpg";
import GalleryPermissionIMG from "@/assets/images/galleryPermissionIMG.jpg";
import PermissionRequestIOS from "@/assets/images/PermissionRequestIOS.jpg";
import FingerAnimation from "@/assets/animations/FingerAnimation.json";
import { useRouter } from "expo-router";
import { usePhotoContext } from "@/app/providers/PhotoContext";
import CustomCarousel from "@/app/components/CustomCarousel/CustomCarousel";
import LottieView from "lottie-react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const { width: screenWidth, height: screenHeight } = Dimensions.get("window");

const InitialScreen: React.FC = () => {
  const router = useRouter();
  const { handleContinue } = usePhotoContext();

  // Maneja el evento de presionar el botón de continuar
  const handleContinuePress = async () => {
    await AsyncStorage.setItem("hasSeenInitialScreen", "true");
    await handleContinue();
    // Navega a la pantalla home
    router.replace("/");
  };

  const androidImages = [
    { id: 1, source: AudioPermissionIMG, title: "Step 1", description: "Tap on Allow." },
    { id: 2, source: GalleryPermissionIMG, title: "Step 2", description: "Tap on Allow all." },
  ];

  // Calculate responsive dimensions for images
  const imageWidth = screenWidth * 0.7;
  const imageHeight = screenHeight * 0.3;

  return (
    <SafeAreaView style={tw`flex-1 bg-gray-900`}>
      <StatusBar barStyle="light-content" backgroundColor="#111827" />
      <ScrollView contentContainerStyle={tw`flex-grow`} showsVerticalScrollIndicator={false}>
        <View style={tw`flex-1 px-4 pt-4 pb-6 max-w-[500px] w-full self-center`}>
          {/* Header */}
          <View style={tw`items-center mb-5`}>
            <View style={tw`bg-amber-900/50 px-4 py-2 rounded-full mb-2`}>
              <Text style={tw`text-xl font-bold text-amber-400`}>⚠️ Warning ⚠️</Text>
            </View>
            <Text style={tw`text-sm text-gray-300 text-center`}>
              For the application to work properly, please grant the following permissions:
            </Text>
          </View>

          {/* Permission highlight box */}
          <View style={tw`bg-indigo-900/30 border border-indigo-700/50 rounded-xl p-4 mb-5`}>
            <Text style={tw`text-sm font-medium text-center text-indigo-300 mb-1`}>Required Permission Setting:</Text>
            <Text style={tw`text-lg font-bold text-center text-indigo-200`}>"Allow all"</Text>
          </View>

          {/* Permission instructions */}
          <View style={tw`bg-gray-800 rounded-xl shadow-lg overflow-hidden mb-5 border border-gray-700`}>
            <View style={tw`bg-gray-700 py-2 px-4 border-b border-gray-600`}>
              <Text style={tw`text-base font-medium text-gray-100`}>
                {Platform.OS === "android" ? "How to enable on Android:" : "How to enable on iOS:"}
              </Text>
            </View>

            {Platform.OS === "android" ? (
              <View style={tw`p-3 items-center`}>
                <CustomCarousel
                  data={androidImages}
                  renderItem={({ item }) => (
                    <View
                      style={[{ width: screenWidth * 0.8, alignItems: "center", justifyContent: "center", paddingVertical: 10 }]}
                    >
                      <View style={tw`bg-gray-700 rounded-lg overflow-hidden shadow-lg mb-3 p-1 border border-gray-600`}>
                        <Image source={item.source} style={{ width: imageWidth, height: imageHeight }} resizeMode="contain" />
                      </View>
                      <Text style={tw`text-base font-bold text-gray-200 mb-1`}>{item.title}</Text>
                      <Text style={tw`text-sm text-gray-400`}>{item.description}</Text>
                    </View>
                  )}
                  disablePagination={false}
                  widthBoundaryForPagination={screenWidth * 0.8}
                  decelerationRate="fast"
                  snapToInterval={screenWidth * 0.8}
                  indicatorColor={["gray", "white", "gray"]}
                  paginationContainerStyle={tw`mt-3`}
                />
              </View>
            ) : (
              <View style={tw`p-3 items-center`}>
                <View style={tw`bg-gray-700 rounded-lg overflow-hidden shadow-lg mb-3 p-1 border border-gray-600`}>
                  <Image source={PermissionRequestIOS} style={{ width: imageWidth, height: imageHeight }} resizeMode="contain" />
                </View>
                <Text style={tw`text-sm text-gray-300 text-center`}>
                  Tap <Text style={tw`text-red-600`}>"Allow all" </Text>
                  to give access to your photos
                </Text>
              </View>
            )}
          </View>

          {/* Continue button and animation */}
          <View style={tw`items-center mt-6`}>
            <TouchableOpacity
              style={tw`bg-blue-600 w-56 py-3 px-5 rounded-full shadow-lg flex-row justify-center items-center border border-blue-500`}
              onPress={handleContinuePress}
              activeOpacity={0.7}
            >
              <Text style={tw`text-white text-base font-medium mr-2`}>Continue</Text>
            </TouchableOpacity>
            <Text style={tw`text-gray-400 text-xs mt-2 mb-2`}>Tap to proceed after setting permissions</Text>
            <LottieView source={FingerAnimation} autoPlay loop style={{ width: 48, height: 48 }} />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

export default InitialScreen;
