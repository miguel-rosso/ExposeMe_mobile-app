import React, { useEffect, useState, useRef, useCallback } from "react";
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
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import tw from "twrnc";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import InitialScreen from "@/app/screens/InitialScreen";
import { useGameContext } from "@/app/providers/GameContext";
import { useLocalSearchParams } from "expo-router";
import { StatusBar } from "react-native";
import * as Animatable from "react-native-animatable";
import ImageBlur from "@/app/components/ImageBlur/ImageBlur";
import { ImageBlurView } from "@/app/components/ImageBlur";
import { useBackHandler } from "@react-native-community/hooks";
import { useFocusEffect } from "@react-navigation/native";
// import logoIndex from "@/assets/images/icon_index.png";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { useBackgroundContext } from "./providers/BackgroundContext";
import { usePhotoContext } from "@/app/providers/PhotoContext"; // Importa el contexto de fotos
import { Ionicons } from "@expo/vector-icons";

SplashScreen.preventAutoHideAsync();
// Animaciones personalizadas para React Native Animatable
Animatable.initializeRegistryWithDefinitions({
  slideInDownBounce: {
    0: {
      opacity: 0,
      translateY: -15,
    },
    0.6: {
      opacity: 1,
      translateY: 10,
    },
    0.75: {
      opacity: 1,
      translateY: -5,
    },
    0.9: {
      opacity: 1,
      translateY: 2,
    },
    1: {
      opacity: 1,
      translateY: 0,
    },
  },
  slideInUpBounce: {
    0: {
      opacity: 0,
      translateY: 15,
    },
    0.6: {
      opacity: 1,
      translateY: -10,
    },
    0.75: {
      opacity: 1,
      translateY: 5,
    },
    0.9: {
      opacity: 1,
      translateY: -2,
    },
    1: {
      opacity: 1,
      translateY: 0,
    },
  },
  slideOutUpBounce: {
    0: {
      opacity: 0,
      translateY: 0,
    },
    0.25: {
      opacity: 1,
      translateY: -10,
    },
    0.5: {
      opacity: 1,
      translateY: -5,
    },
    0.75: {
      opacity: 1,
      translateY: 5,
    },
    1: {
      opacity: 1,
      translateY: 0,
    },
  },
  slideOutDownBounce: {
    0: {
      opacity: 0,
      translateY: 0,
    },
    0.25: {
      opacity: 1,
      translateY: 10,
    },
    0.5: {
      opacity: 1,
      translateY: 5,
    },
    0.75: {
      opacity: 1,
      translateY: -5,
    },
    1: {
      opacity: 1,
      translateY: 0,
    },
  },
  slideOutDownFar: {
    0: {
      opacity: 1,
      translateY: 0,
    },
    1: {
      opacity: 0,
      translateY: 100,
    },
  },
  slideOutUpFar: {
    0: {
      opacity: 1,
      translateY: 0,
    },
    1: {
      opacity: 0,
      translateY: -200,
    },
  },
  slideInDownFar: {
    0: {
      opacity: 0,
      translateY: -200,
    },
    1: {
      opacity: 1,
      translateY: 0,
    },
  },
});

const Index = () => {
  const router = useRouter();
  const params = useLocalSearchParams();
  const message = params?.message;
  const [isLoading, setIsLoading] = useState(true);
  const [hasSeenInitialScreen, setHasSeenInitialScreen] = useState(false);
  const { setUsername, username, setGameCode, gameCode, socket, endSocket } = useGameContext();
  const { backgroundImage } = useBackgroundContext();
  const [isJoiningGame, setIsJoiningGame] = useState(false);
  const [shouldAnimateCreateGameButton, setShouldAnimateCreateGameButton] = useState(false);
  const [isFirstMount, setIsFirstMount] = useState(true);
  const gameCodeInputRef = useRef<TextInput>(null);
  const usernameInputRef = useRef<Animatable.View & View>(null);
  const gameCodeAnimRef = useRef<Animatable.View & View>(null);
  const createGameButtonRef = useRef<Animatable.View & View>(null);
  const JoingameButtonRef = useRef<Animatable.View & View>(null);
  const buttonRef = useRef<Animatable.View & View>(null);
  const textRef = useRef<Animatable.View & View>(null);
  const topLogoRef = useRef<Animatable.View & View>(null);
  const { requestGalleryPermission } = usePhotoContext(); // Usa el contexto de fotos

  // Get screen dimensions
  const { width, height } = Dimensions.get('window');
  
  // Calculate text size based on screen dimensions
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

  // useEffect para cargar datos iniciales
  useEffect(() => {
    const checkInitialScreen = async () => {
      const value = await AsyncStorage.getItem("hasSeenInitialScreen");
      setHasSeenInitialScreen(value === "true");
      setIsLoading(false);
    };

    const loadUsername = async () => {
      const storedUsername = await AsyncStorage.getItem("username");
      if (storedUsername) {
        setUsername(storedUsername);
      }
    };

    checkInitialScreen();
    loadUsername();

    if (message) {
      alert(message);
    }
  }, []);

  // useFocusEffect para manejar el intervalo de cambio de fondo
  useFocusEffect(
    useCallback(() => {
      if (socket) {
        console.log("desconectando socket");
        endSocket();
      }
    }, [socket, endSocket])
  );

  // useEffect para manejar las animaciones cuando cambia el estado isJoiningGame
  useEffect(() => {
    if (!isJoiningGame && !isFirstMount) {
      console.log("RESET CREATE GAME BUTTON ANIMATION");
      setShouldAnimateCreateGameButton(true);
      (usernameInputRef.current as any)?.slideOutUpBounce?.(600);
      (JoingameButtonRef.current as any)?.slideOutDownBounce?.(600);
    }
    if (isFirstMount) {
      setIsFirstMount(false);
    }
  }, [isJoiningGame]);

  // Manejar el evento de retroceso en Android
  useBackHandler(() => {
    if (isJoiningGame) {
      handleCancelJoinGame();
      return true; // Prevenir el comportamiento por defecto (salir de la app)
    }
    return false; // Permitir el comportamiento por defecto
  });

  // Manejar el cambio de nombre de usuario
  const handleUsernameChange = async (text: string) => {
    setUsername(text);
    await AsyncStorage.setItem("username", text);
  };

  // Manejar la acción de unirse a un juego
  const handleJoinGame = () => {
    if (!username) {
      (usernameInputRef.current as any)?.shake?.(500);
      return;
    }

    setIsJoiningGame(true);
  };

  // Manejar la acción de crear un juego
  const handleCreateGame = async () => {
    if (!username) {
      (usernameInputRef.current as any)?.shake?.(500);
      return;
    }

    const hasPermission = await requestGalleryPermission({ askAgain: true });
    if (!hasPermission) {
      return;
    }

    setGameCode(null); // Limpiar el gameCode antes de navegar
    console.log("Navigating to WaitingRoom");
    router.push("/screens/WaitingRoom");
  };

  // Manejar la acción de buscar una sala
  const handleSearchRoom = async () => {
    if (!gameCode) {
      (gameCodeAnimRef.current as any)?.shake?.(500);
      return;
    }

    const hasPermission = await requestGalleryPermission({ askAgain: true });
    if (!hasPermission) {
      return;
    }

    router.push("/screens/WaitingRoom");
  };

  // Manejar la navegación a otra pantalla con animación
  const NavigateOwnPhotos = (path: string) => {
    (buttonRef.current as any)?.slideOutDownFar?.(500);
    (textRef.current as any)?.slideOutDownFar?.(500);
    (usernameInputRef.current as any)?.fadeOut(500);
    (createGameButtonRef.current as any)?.fadeOut(500);
    (JoingameButtonRef.current as any)?.fadeOut(500);
    (topLogoRef.current as any)?.slideOutUpFar(500);
    setTimeout(() => {
      router.push(path as any);
    }, 500);
  };

  // Manejar la acción de cancelar unirse a un juego
  const handleCancelJoinGame = () => {
    console.log("CANCEL JOIN GAME");
    setIsJoiningGame(false);
    setShouldAnimateCreateGameButton(true);
    (usernameInputRef.current as any)?.slideInDownBounce?.(600);
    (JoingameButtonRef.current as any)?.slideInUpBounce?.(600);
  };

  // Mostrar un indicador de carga si los datos iniciales aún se están cargando
  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  // Mostrar la pantalla inicial si el usuario no la ha visto antes
  if (!hasSeenInitialScreen) {
    return <InitialScreen />;
  }

  return (
    <>
      <View style={tw`absolute w-full h-full bg-black`}>
        <StatusBar hidden />
        {/* Fondo desenfocado */}
        <ImageBlur
          src={backgroundImage}
          blurRadius={3} // intensidad del blur
          blurChildren={<ImageBlurView style={{ height: "100%", width: "100%", backgroundColor: "black" }} />}
          style={{ flex: 1 }}
        />
      </View>
      <View style={tw`flex-1 justify-center items-center `}>
        {/* Logo en la parte superior */}
        <Animatable.View ref={topLogoRef} animation="slideInDown" duration={600} style={tw`absolute top-[10%]`}>
          <View style={tw` flex-1 items-center  max-w-[300px] w-[100%] h-70`}>
            <Text
              style={[
                tw`text-white ${getTitleFontSize()}  z-10 text-center pt-15`,
                {
                  fontFamily: "IconFont",
                  textShadowColor: "rgba(0, 0, 0, 0.5)",
                  textShadowOffset: { width: 10, height: 5 },
                  textShadowRadius: 3,
                },
              ]}
            >
              Expose Me
            </Text>
            <Image
              source={require("@/assets/images/carasonrojada.png")}
              style={tw` z-4 top-[-10] right-[-20] size-[70%] absolute`}
              resizeMode="contain"
            />
          </View>
        </Animatable.View>

        <View style={tw`px-2 flex-1 w-full justify-center pt-[18%] items-center`}>
          {/* Mostrar el formulario de ingreso de usuario y botones si no se está uniendo a un juego */}
          {!isJoiningGame && (
            <>
              {/* Input para ingresar el nombre de usuario */}
              <Animatable.View
                ref={usernameInputRef}
                animation={shouldAnimateCreateGameButton ? "fadeIn" : undefined}
                duration={600}
                style={tw`w-full flex items-center justify-center mb-4 relative`}
              >
                <TextInput
                  style={tw`h-15 rounded-2xl  w-full bg-white font-bold text-center text-lg`}
                  placeholder="Enter username"
                  placeholderTextColor="#3333"
                  value={username || ""}
                  onChange={(e) => handleUsernameChange(e.nativeEvent.text)}
                  maxLength={15}
                />
                {username && username.length > 0 && (
                  <View style={tw`absolute flex items-center justify-center h-full absolute right-4`}>
                    <TouchableOpacity
                      style={tw` justify-center  bg-gray-200 h-8 w-8 rounded-full flex items-center justify-center`}
                      onPress={() => {
                        handleUsernameChange("");
                        Keyboard.dismiss();
                      }}
                    >
                      <Ionicons name="close-outline" size={24} color="black" />
                    </TouchableOpacity>
                  </View>
                )}
              </Animatable.View>

              {/* Botón para crear un juego */}
              <Animatable.View
                ref={createGameButtonRef}
                animation={shouldAnimateCreateGameButton ? "fadeIn" : undefined}
                duration={600}
                style={tw`w-full`}
              >
                <LinearGradient
                  colors={["#9d0420", "#e9042e", "#9d0420"]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={tw`p-4 rounded-2xl mb-4 w-full`}
                >
                  <TouchableOpacity style={tw`w-full`} onPress={handleCreateGame}>
                    <Text style={tw`text-white text-center text-lg font-bold`}>Create Game</Text>
                  </TouchableOpacity>
                </LinearGradient>
              </Animatable.View>

              {/* Botón para unirse a un juego */}
              <Animatable.View
                ref={JoingameButtonRef}
                animation={shouldAnimateCreateGameButton ? "fadeIn" : undefined}
                duration={600}
                style={tw`w-full`}
              >
                <LinearGradient
                  colors={["#9d0420", "#e9042e", "#9d0420"]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={tw`p-4 rounded-2xl mb-4 w-full`}
                >
                  <TouchableOpacity onPress={handleJoinGame}>
                    <Text style={tw`text-white text-center text-lg font-bold`}>Join Game</Text>
                  </TouchableOpacity>
                </LinearGradient>
              </Animatable.View>
            </>
          )}

          {/* Mostrar el formulario de ingreso de código de juego si se está uniendo a un juego */}
          {isJoiningGame && (
            <TouchableWithoutFeedback onPress={handleCancelJoinGame}>
              <View style={tw`flex-1 w-full justify-center items-center`}>
                {/* Input para ingresar el código del juego */}
                <Animatable.View
                  ref={gameCodeAnimRef}
                  animation="slideInDownBounce"
                  duration={600}
                  style={tw`w-full mb-4 relative`}
                >
                  <TextInput
                    ref={gameCodeInputRef}
                    style={tw`p-4 rounded-xl  w-full bg-white text-center text-lg font-bold`}
                    placeholder="Enter game code"
                    placeholderTextColor="#3333"
                    value={gameCode || ""}
                    onChange={(e) => setGameCode(e.nativeEvent.text)}
                    keyboardType="number-pad"
                    maxLength={6}
                  />
                  {gameCode && gameCode.length > 0 && (
                    <View style={tw`absolute right-4 h-full flex justify-center items-center`}>
                      <TouchableOpacity
                        style={tw`  bg-gray-200 h-8 w-8 rounded-full flex items-center justify-center`}
                        onPress={() => {
                          setGameCode("");
                          Keyboard.dismiss();
                        }}
                      >
                        <Ionicons name="close-outline" size={24} color="black" />
                      </TouchableOpacity>
                    </View>
                  )}
                </Animatable.View>

                {/* Botón para buscar una sala */}
                <Animatable.View animation="slideInUpBounce" duration={600} style={tw`w-full`}>
                  <LinearGradient
                    colors={["#9d0420", "#e9042e", "#9d0420"]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={tw`p-4 rounded-2xl mb-4 w-full`}
                  >
                    <TouchableOpacity style={tw` w-full `} onPress={handleSearchRoom}>
                      <Text style={tw`text-white text-center text-lg font-bold`}>Search Room</Text>
                    </TouchableOpacity>
                  </LinearGradient>
                </Animatable.View>
              </View>
            </TouchableWithoutFeedback>
          )}
        </View>
        {/* Botón para navegar a la pantalla de fotos propias */}
        <Animatable.View ref={buttonRef} animation="slideInUp" duration={600} style={tw`absolute bottom-22 items-center`}>
          <TouchableOpacity style={tw`bg-white/50 p-3  rounded-3xl`} onPress={() => NavigateOwnPhotos("/screens/OwnPhotos")}>
            <Ionicons name="dice" size={44} color="white" />
          </TouchableOpacity>
        </Animatable.View>
        <Animatable.View ref={textRef} animation="slideInUp" duration={600} style={tw`absolute bottom-15`}>
          <Text style={tw`text-white font-bold`}>Photo Explorer</Text>
        </Animatable.View>
      </View>
    </>
  );
};

export default Index;
