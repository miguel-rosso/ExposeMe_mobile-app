import multer from "multer";
import path from "path";
import fs from "fs";
import { NextFunction, Request, Response } from "express";

// UPLOAD_DIR overrides the default Server/temp (tests use a throwaway directory)
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "../temp");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Kept in memory: UploadController checks the real format from the bytes (the declared MIME type is not
// trusted, so it is not filtered here), re-encodes the image and writes it under a random name.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

/** multer.single(field) with JSON errors: 413 for a file over MAX_FILE_SIZE, 400 for any other malformed upload. */
export function singleImage(field: string) {
  const handler = upload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, (err?: unknown) => {
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
