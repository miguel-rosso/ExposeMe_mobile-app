import React, { forwardRef, useImperativeHandle, useRef, useState, useCallback } from "react";
import { Animated, Dimensions, View, NativeSyntheticEvent, NativeScrollEvent, FlatList } from "react-native";
import { CustomCarouselProps, RefProps } from "@/app/components/CustomCarousel/Interfaces";
import PressablePagination from "@/app/components/CustomCarousel/PressablePagination";

const { width: WIDTH } = Dimensions.get("window");
const DEFAULT_INDICATOR_BORDER_RADIUS = 5;

const CustomCarousel = forwardRef<RefProps, CustomCarouselProps>(({ disablePagination = false, ...props }, ref) => {
  const flatlistRef = useRef<FlatList>(null);
  const scrollX = useRef(new Animated.Value(0)).current;
  const [currentItemIndex, setCurrentItemIndex] = useState<number>(0);

  const borderRadius = props.indicatorBorderRadius ?? DEFAULT_INDICATOR_BORDER_RADIUS;

  useImperativeHandle(ref, () => {
    return {
      showNextItem() {
        if (currentItemIndex < props.data.length - 1)
          flatlistRef.current?.scrollToIndex({
            index: currentItemIndex + 1,
            animated: true,
          });
      },
      showPreviousItem() {
        if (currentItemIndex > 0)
          flatlistRef.current?.scrollToIndex({
            index: currentItemIndex - 1,
            animated: true,
          });
      },
    };
  }, [currentItemIndex, props.data.length]);

  const handleScroll = Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: false });

  const endReached = useCallback(() => {
    if (props.isEndReached) props.isEndReached(true);
  }, [props.isEndReached]);

  const scrollFunction = useCallback(
    (index: number) => {
      flatlistRef.current?.scrollToOffset({
        offset: index * (props.widthBoundaryForPagination ?? WIDTH),
        animated: true,
      });
    },
    [props.widthBoundaryForPagination]
  );

  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    if (viewableItems && viewableItems.length > 0) {
      setCurrentItemIndex(viewableItems[0].index);
    }
  }).current;

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 50,
    minimumViewTime: 200,
  }).current;

  // Add getItemLayout for performance
  const getItemLayout = useCallback(
    (_data: ArrayLike<unknown> | null | undefined, index: number) => {
      const itemWidth = props.widthBoundaryForPagination ?? WIDTH;
      return {
        length: itemWidth,
        offset: itemWidth * index,
        index,
      };
    },
    [props.widthBoundaryForPagination]
  );

  return (
    <View style={[{ flexGrow: 0 }, props.mainContainerStyle]} testID="content-container">
      <FlatList
        ref={flatlistRef}
        data={props.data}
        renderItem={props.renderItem}
        style={[{ flexGrow: 0 }, props.carouselContainerStyle]}
        contentContainerStyle={props.carouselContentContainerStyle}
        horizontal
        showsHorizontalScrollIndicator={false}
        pagingEnabled
        snapToAlignment="center"
        onScroll={handleScroll}
        viewabilityConfig={viewabilityConfig}
        onViewableItemsChanged={onViewableItemsChanged}
        onEndReached={endReached}
        decelerationRate={props.decelerationRate || "fast"}
        snapToInterval={props.snapToInterval}
        getItemLayout={getItemLayout}
        initialNumToRender={3}
        maxToRenderPerBatch={3}
        windowSize={5}
        removeClippedSubviews={true}
      />
      {!disablePagination && (
        <View
          style={props.paginationContainerStyle}
          accessibilityElementsHidden={true}
          importantForAccessibility={"no-hide-descendants"}
        >
          <PressablePagination
            data={props.data}
            scrollX={scrollX}
            getIndex={scrollFunction}
            itemWidth={props.widthBoundaryForPagination ?? WIDTH}
            indicatorHeight={props.indicatorHeight ?? [15, 15, 15]}
            indicatorWidth={props.indicatorWidth ?? [20, 40, 20]}
            indicatorColor={props.indicatorColor ?? ["grey", "black", "grey"]}
            paginataionBackgroundColor={props.paginataionBackgroundColor ?? "transparent"}
            indicatorBorderRadius={borderRadius}
            indicatorHorizontalPadding={props.indicatorHorizontalPadding ?? 10}
          />
        </View>
      )}
    </View>
  );
});

export default CustomCarousel;
