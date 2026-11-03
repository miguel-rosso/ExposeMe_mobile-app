import { Image, Platform, TurboModuleRegistry, type ImageSourcePropType, type TurboModule } from 'react-native';

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

/** A remote (http/https) URI: the server's room photos, as opposed to on-device gallery URIs. */
export const isRemoteUri = (src: ImageSrc): src is string => typeof src === 'string' && /^https?:\/\//i.test(src);

/** React Native's Blob: its bytes live in the native blob store, under `data.blobId`, until close() frees them. */
type NativeBlob = Blob & { close(): void; data: { blobId: string; offset: number } };

/** React Native's native blob module: the URI scheme (and host, if any) its blob URIs use. */
interface NativeBlobModule extends TurboModule {
  getConstants(): { BLOB_URI_SCHEME?: string | null; BLOB_URI_HOST?: string | null };
}

/**
 * The URI an <Image> reads a native blob from, built as React Native's own URL.createObjectURL builds it. The app
 * can't call URL.createObjectURL: Expo replaces the global URL with one whose createObjectURL looks the blob module up
 * through global.__turboModuleProxy, which React Native's bridgeless runtime never defines, so it always throws
 * (EXP-404). Throws when the native blob module gives no URI scheme.
 */
const nativeBlobUri = (blob: NativeBlob): string => {
  const constants = TurboModuleRegistry.get<NativeBlobModule>('BlobModule')?.getConstants();
  const scheme = constants?.BLOB_URI_SCHEME;
  if (typeof scheme !== 'string') throw new Error('Cannot create URL for blob');
  const host = constants?.BLOB_URI_HOST;
  const prefix = typeof host === 'string' ? `${scheme}://${host}/` : `${scheme}:`;
  return `${prefix}${blob.data.blobId}?offset=${blob.data.offset}&size=${blob.size}`;
};

/** XMLHttpRequest.LOADING: React Native has received the whole blob response and created its native blob. */
const XHR_RESPONSE_ARRIVED = 3;

/**
 * How long a photo download may receive nothing before it gives up (EXP-401), so its caller falls back to the photo
 * URL as on a failure: a stalled download fires neither load nor error and would keep the loading indicator up for the
 * whole round. It is the native request timeout, which on iOS (NSURLRequest.timeoutInterval) restarts whenever data
 * arrives: a slow photo that keeps arriving is never cut off, a silent connection is. 3 s of silence is far beyond a
 * working network's first byte, and leaves the retry most of the 7.7 s answer bar.
 */
export const PHOTO_DOWNLOAD_STALL_TIMEOUT_MS = 3_000;

/** A photo downloaded once into native memory, for several <Image> views to draw without downloading it again. */
export interface MemoryImage {
  /** Resolves with a local `blob:` URI of the photo; rejects if the download fails. */
  uri: Promise<string>;
  /** Cancels the download or frees the downloaded photo. Call it once no <Image> needs the URI any more. */
  release: () => void;
}

/**
 * Downloads a remote photo with its request headers into React Native's native blob store (never to disk), and gives
 * a `blob:` URI that any number of <Image> views read from memory. React Native's iOS image loader neither joins
 * concurrent requests for the same URL nor keeps `no-store` responses (the server sends room photos that way, on
 * purpose), so two <Image> views of the photo URL would download it twice (EXP-394). iOS only: Android's Image can't
 * read `blob:` URIs, and its pipeline already shares one download between views (see prefetchImage).
 *
 * Every native blob the request creates has an owner: the caller once the URI resolves (it frees it with release),
 * otherwise this function, which frees it when the download failed or was released before it finished. A download
 * that stalls fails after PHOTO_DOWNLOAD_STALL_TIMEOUT_MS.
 */
export const downloadImageToMemory = (uri: string, headers: Record<string, string> = {}): MemoryImage => {
  let request: XMLHttpRequest | null = null;
  let blob: NativeBlob | null = null;
  let released = false;
  // Anything thrown while starting the request rejects the download: the caller falls back, nothing breaks
  const blobUri = new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    request = xhr;
    xhr.onload = () => {
      // Any status comes with a native blob (an error page too)
      const downloaded = xhr.response as NativeBlob | null;
      if (released || xhr.status < 200 || xhr.status >= 300) {
        downloaded?.close();
        reject(new Error(released ? 'Photo download released' : `Photo download failed with HTTP ${xhr.status}`));
        return;
      }
      try {
        resolve(nativeBlobUri(downloaded!));
        blob = downloaded;
      } catch (error) {
        // An event handler: nothing would settle the download if this threw
        downloaded?.close();
        reject(error);
      }
    };
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new Error('Photo download failed'));
    xhr.open('GET', uri);
    // The response stays in native memory: the photo's bytes never cross into JS
    xhr.responseType = 'blob';
    xhr.timeout = PHOTO_DOWNLOAD_STALL_TIMEOUT_MS;
    Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    xhr.send();
  });

  const release = () => {
    if (released) return;
    released = true;
    if (blob) blob.close();
    // Once the response has arrived its native blob exists: aborting would drop it unfreed, so onload frees it
    else if (request && request.readyState < XHR_RESPONSE_ARRIVED) request.abort();
  };
  return { uri: blobUri, release };
};

export default getImageSource;
