import { type ImageSourcePropType } from 'react-native';

/** A remote/local URI, or the numeric asset id Metro gives a bundled image import. */
export type ImageSrc = string | number;

/** Image source for a URI (with request headers, e.g. photoAuthHeaders for server photos) or a bundled asset. */
export const getImageSource = (src: ImageSrc, headers?: Record<string, string>): ImageSourcePropType => {
  return typeof src === 'string'
    ? {
        uri: src,
        ...(headers ? { headers } : {}),
      }
    : (src as ImageSourcePropType);
};

export default getImageSource;
