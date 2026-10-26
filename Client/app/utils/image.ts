import { Image, Platform, type ImageSourcePropType } from 'react-native';

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

/**
 * Starts downloading a remote photo into the image cache before an <Image> of it is mounted, with the same request
 * headers the <Image> sends (room photos need photoAuthHeaders). Best effort: the <Image> loads it anyway.
 *
 * Image.prefetch can't send headers on any platform, so this goes through Image.getSizeWithHeaders, which on Android
 * fetches the photo through Fresco's pipeline into its encoded memory and disk caches: the photo's <Image> views then
 * join that download or read the cached file. Android only: the server sends room photos as `no-store` and React
 * Native's iOS image loader honours that, so on iOS a prefetch would only download the photo twice.
 */
export const prefetchImage = (uri: string, headers: Record<string, string> = {}): void => {
  if (Platform.OS !== 'android') return;
  try {
    Image.getSizeWithHeaders(uri, headers).catch(() => {});
  } catch {
    // Never breaks its caller (a socket handler with more work after it), not even without the native loader
  }
};

export default getImageSource;
