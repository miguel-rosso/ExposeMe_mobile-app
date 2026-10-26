import React, { useRef, useState, useEffect, useMemo } from 'react';
import { Image, View, ViewStyle } from 'react-native';

import { ImageBlurProvider } from '../../providers/ImageBlurContext';
import { getImageSource, type ImageSrc } from '../../utils/image';

import ImageBlurShape, { type ImageBlurShapeProps } from './ImageBlurShape';

import styles from './ImageBlur.styles';

type ImageBlurContainerSize = {
  height: number | undefined;
  width: number | undefined;
};

export type ImageBlurRadius = number;

export type ImageBlurProps = {
  blurChildren: ImageBlurShapeProps['children'];
  children?: React.ReactNode;
  resizeMode?: ImageBlurShapeProps['resizeMode'];
  src: ImageSrc;
  /** Request headers for `src` (server photos need the room credentials) */
  headers?: Record<string, string>;
  blurRadius?: ImageBlurRadius;
  style?: ViewStyle;
};

const ImageBlur = ({
  blurChildren,
  children,
  resizeMode = 'cover',
  src,
  headers,
  blurRadius = 10,
  style,
}: ImageBlurProps) => {
  const [containerSize, setContainerSize] = useState<ImageBlurContainerSize>({
    height: undefined,
    width: undefined,
  });

  const containerRef = useRef<View | null>(null);
  // Backdrop image; server photos need the room credentials. Memoised so the native image doesn't reload.
  const source = useMemo(() => getImageSource(src, headers), [src, headers]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.setNativeProps({ style: { opacity: 1 } });
    }
  }, [containerSize]);

  return (
    <View
      onLayout={({ nativeEvent }) => {
        setContainerSize({
          width: nativeEvent.layout.width,
          height: nativeEvent.layout.height,
        });
      }}
      style={[
        styles.container,
        style,
      ]}
    >
      {containerSize.height && containerSize.width && (
        <View
          ref={containerRef}
          style={[styles.sticked, styles.fitAvailableSpace]}
        >
          <ImageBlurProvider>
            <ImageBlurShape
              containerRef={containerRef}
              image={{
                height: containerSize.height,
                src,
                headers,
                width: containerSize.width,
              }}
              resizeMode={resizeMode}
              blurRadius={blurRadius}
            >
              {blurChildren}
            </ImageBlurShape>
          </ImageBlurProvider>
        </View>
      )}
      <Image
        style={[styles.sticked, styles.fitAvailableSpace]}
        resizeMode={resizeMode}
        source={source}
        blurRadius={blurRadius}
      />
      {children}
    </View>
  );
};

export default ImageBlur;