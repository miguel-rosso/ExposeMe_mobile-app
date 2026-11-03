import multer from "multer";
import path from "path";
import fs from "fs";
import { NextFunction, Request, Response } from "express";

/**
 * Server/ root: the nearest directory above `fromDir` holding package.json. Works both from the sources
 * (ts-node, Server/middlewares) and from the compiled build (Server/dist/middlewares).
 */
export function findServerRoot(fromDir: string): string {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) throw new Error(`No package.json above ${fromDir}`);
  }
}

// UPLOAD_DIR overrides the default Server/temp (tests use a throwaway directory)
const uploadDir = process.env.UPLOAD_DIR || path.join(findServerRoot(__dirname), "temp");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/**
 * The app re-encodes every photo as a JPEG of at most 1600 px (q0.8, ~300-600 KB; Client/src/utils/uploadPhoto.ts),
 * so 5 MB leaves ample headroom while bounding what each in-flight upload can buffer (middlewares/uploadInFlight).
 */
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// Kept in memory: UploadController checks the real format from the bytes (the declared MIME type is not
// trusted, so it is not filtered here), re-encodes the image and writes it under a random name.
const upload = multer({
  storage: multer.memoryStorage(),
  // The upload carries only the photo: any text field aborts it (LIMIT_FIELD_COUNT) before its name or value is
  // parsed into req.body, and any other extra part, even one busboy would skip, aborts it too (LIMIT_PART_COUNT);
  // both are answered with a 400
  limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 0, parts: 1 },
});

/**
 * multer.single(field) with JSON errors: 413 for a file over MAX_FILE_SIZE, 400 for any other malformed upload
 * (a text field, a second file, a wrong field name, a broken multipart body).
 */
export function singleImage(field: string) {
  const handler = upload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, (err?: unknown) => {
      // Already answered (the upload timed out, see middlewares/uploadInFlight): don't process or answer twice
      if (res.headersSent) return;
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "File too large" });
      } else {
        res.status(400).json({ error: "Invalid upload" });
      }
    });
  };
}

export const uploadPath = uploadDir;
