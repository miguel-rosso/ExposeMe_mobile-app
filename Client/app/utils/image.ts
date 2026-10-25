import { type ImageSourcePropType } from 'react-native';

/** Image source for a URI (with request headers, e.g. photoAuthHeaders for server photos) or a bundled asset. */
export const getImageSource = (src: string | number, headers?: Record<string, string>): ImageSourcePropType => {
  return typeof src === 'string'
    ? {
        uri: src,
        ...(headers ? { headers } : {}),
      }
    : (src as ImageSourcePropType);
};

export default getImageSource;
