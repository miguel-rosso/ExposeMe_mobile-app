import React from "react";
import { TouchableOpacity, View, Animated } from "react-native";
import { PressablePaginationProps } from "@/app/components/CustomCarousel/Interfaces";
import { styles } from "@/app/components/CustomCarousel/PressablePagination.styles";

const PressablePagination = (props: PressablePaginationProps) => {
  return (
    <>
      <View
        style={styles.parentContainer(
          props.indicatorHeight ? props.indicatorHeight[1] + 5 : 20,
          props.paginataionBackgroundColor
        )}
      >
        {props.data.map((_, idx) => {
          // Updated input range calculation for better alignment
          const inputRange = [
            (idx - 0.5) * props.itemWidth,
            idx * props.itemWidth,
            (idx + 0.5) * props.itemWidth,
          ];
          
          const indicatorWidth = props.scrollX.interpolate({
            inputRange,
            outputRange: props.indicatorWidth,
            extrapolate: "clamp",
          });
          
          const indicatorHeight = props.scrollX.interpolate({
            inputRange,
            outputRange: props.indicatorHeight,
            extrapolate: "clamp",
          });
          
          const backgroundColor = props.scrollX.interpolate({
            inputRange,
            outputRange: props.indicatorColor,
            extrapolate: "clamp",
          });
          
          return (
            <TouchableOpacity
              key={idx}
              testID={`pagination-indicator-${idx}`}
              onPress={() => props.getIndex(idx)}
              style={styles.buttonContainer(props.indicatorHorizontalPadding)}
            >
              <Animated.View
                key={idx.toString()}
                style={styles.buttonStyle(
                  indicatorWidth,
                  indicatorHeight,
                  backgroundColor,
                  props.indicatorBorderRadius
                )}
              />
            </TouchableOpacity>
          );
        })}
      </View>
    </>
  );
};

export default PressablePagination;