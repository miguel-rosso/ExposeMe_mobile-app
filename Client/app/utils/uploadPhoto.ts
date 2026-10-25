import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

// ── Upload of a local photo to POST /upload ──

/**
 * Longest side of the uploaded photo. Photos are shown full-screen (contain) on phones whose
 * screens are ~1080–1290 px wide, so 1600 px keeps them sharp while a q0.8 JPEG stays around
 * 300–600 KB (vs 3–12 MB originals), well within PHOTO_WAIT_TIMEOUT on mobile data.
 */
export const UPLOAD_MAX_SIDE = 1600;
export const UPLOAD_JPEG_QUALITY = 0.8;

/**
 * Fixed, server-safe part filename: gallery names can contain spaces, accents or parentheses that
 * the server's upload path check rejects, and may leak the source app, capture time or device.
 */
export const UPLOAD_FILE_NAME = "photo.jpg";
export const UPLOAD_FILE_TYPE = "image/jpeg";

/**
 * Re-encodes the photo at `uri` as a JPEG whose longest side is at most UPLOAD_MAX_SIDE, with the
 * EXIF orientation baked into the pixels and no metadata kept (HEIC/PNG/WebP all become JPEG).
 * Returns the URI of the converted file in the cache directory.
 */
export const convertForUpload = async (uri: string): Promise<string> => {
  // Bounds applied while decoding: large photos are downsampled without loading them in full.
  const context = ImageManipulator.manipulate(uri, { maxWidth: UPLOAD_MAX_SIDE, maxHeight: UPLOAD_MAX_SIDE });
  try {
    const image = await context.renderAsync();
    try {
      const result = await image.saveAsync({ format: SaveFormat.JPEG, compress: UPLOAD_JPEG_QUALITY });
      return result.uri;
    } finally {
      image.release();
    }
  } catch (error) {
    throw new Error(`Photo conversion failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    context.release();
  }
};

/** Converts and uploads the photo at `uri`; returns the server path (`/temp/...`). Throws on failure. */
export const uploadPhoto = async (serverUrl: string, uri: string): Promise<string> => {
  const file = new File(await convertForUpload(uri));
  try {
    const formData = new FormData();
    // expo/fetch (global fetch since SDK 56) serializes Blob-like parts exposing bytes(); it can't
    // rename an expo-file-system File (read-only name), so wrap it to send the safe filename.
    formData.append("image", {
      name: UPLOAD_FILE_NAME,
      type: UPLOAD_FILE_TYPE,
      bytes: () => file.bytes(),
    } as unknown as Blob);
    const response = await fetch(`${serverUrl}/upload`, { method: "POST", body: formData });
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
    return (await response.json()).url;
  } finally {
    // The converted copy is only needed for this request.
    try {
      file.delete();
    } catch {}
  }
};
