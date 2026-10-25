import { File } from "expo-file-system";

// ── Upload of a local photo to POST /upload ──

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

/**
 * Fixed, server-safe part filename (`photo.<ext>`): gallery names can contain spaces, accents or
 * parentheses that the server's upload path check rejects.
 */
export const uploadFileMeta = (extension: string | undefined, mime: string | undefined) => {
  const fromExt = (extension ?? "").replace(/^\./, "").toLowerCase();
  const ext = MIME_BY_EXT[fromExt] ? fromExt : EXT_BY_MIME[(mime ?? "").toLowerCase()] ?? "jpg";
  return { name: `photo.${ext}`, type: MIME_BY_EXT[ext] };
};

/** Uploads the file at `uri` and returns the server path (`/temp/...`). Throws on failure. */
export const uploadPhoto = async (serverUrl: string, uri: string): Promise<string> => {
  const file = new File(uri);
  const { name, type } = uploadFileMeta(file.extension, file.type);
  const formData = new FormData();
  // expo/fetch (global fetch since SDK 56) serializes Blob-like parts exposing bytes(); it can't
  // rename an expo-file-system File (read-only name), so wrap it to send the safe filename.
  formData.append("image", { name, type, bytes: () => file.bytes() } as unknown as Blob);
  const response = await fetch(`${serverUrl}/upload`, { method: "POST", body: formData });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
  return (await response.json()).url;
};
