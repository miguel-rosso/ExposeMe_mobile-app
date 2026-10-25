import fs from "fs";
import path from "path";
import { Request, Response } from "express";

// ── Upload expiry ──
// Uploaded photos live for UPLOAD_TTL_MS. Expiry is based on the file's mtime on disk, not only on in-memory
// timers, so photos left behind by a restart are still removed: a sweep runs at startup and every
// SWEEP_INTERVAL_MS, each sweep schedules exact deletion for files that expire before the next one, and
// /temp refuses to serve a file that is already past its TTL.

export const UPLOAD_TTL_MS = 30 * 60 * 1000; // 30 minutes — games can last 15+ min
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Names produced by UploadController; nothing else in the upload dir (e.g. .gitkeep) is ever touched. */
export const UPLOAD_FILE_RE = /^[0-9a-f]{32}\.(?:jpg|png|webp)$/;

const remainingMs = (mtimeMs: number, ttlMs: number, now: number) => mtimeMs + ttlMs - now;

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

/** Deletes `dir/name` if it is a regular file past its TTL. Returns true if it was deleted. */
async function deleteIfExpired(dir: string, name: string, ttlMs: number): Promise<boolean> {
  const file = path.join(dir, name);
  try {
    const st = await fs.promises.lstat(file);
    if (!st.isFile() || remainingMs(st.mtimeMs, ttlMs, Date.now()) > 0) return false;
    await fs.promises.unlink(file);
    return true;
  } catch (err) {
    if (!isMissing(err)) console.error("Error deleting upload:", err);
    return false;
  }
}

/**
 * Deletes upload files in `dir` whose mtime is at least `ttlMs` old. Returns the deleted file names.
 * `onFresh` is called for every upload file kept, with the epoch ms at which it expires.
 */
export async function sweepUploads(
  dir: string,
  ttlMs = UPLOAD_TTL_MS,
  now = Date.now(),
  onFresh?: (name: string, expiresAt: number) => void,
): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const deleted: string[] = [];
  for (const name of names) {
    if (!UPLOAD_FILE_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = await fs.promises.lstat(file);
      if (!st.isFile()) continue;
      if (remainingMs(st.mtimeMs, ttlMs, now) > 0) {
        onFresh?.(name, st.mtimeMs + ttlMs);
        continue;
      }
      await fs.promises.unlink(file);
      deleted.push(name);
    } catch (err) {
      if (!isMissing(err)) console.error("Error sweeping upload:", err);
    }
  }
  return deleted;
}

export interface UploadSweeper {
  /** Clears the interval and every pending per-file timer. */
  stop: () => void;
  /** Resolves once every sweep/deletion started so far has finished (tests). */
  idle: () => Promise<void>;
}

/**
 * Runs a sweep now and then every `intervalMs`. Files that expire before the next sweep get an exact
 * per-file timer, so no upload outlives its TTL (including leftovers from a previous process).
 * All timers are unref'd, so they never keep the process alive.
 */
export function startUploadSweeper(dir: string, ttlMs = UPLOAD_TTL_MS, intervalMs = SWEEP_INTERVAL_MS): UploadSweeper {
  const pending = new Map<string, NodeJS.Timeout>();
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = (task: () => Promise<unknown>) => {
    chain = chain.then(task).catch((err) => console.error("Upload sweep failed:", err));
  };

  const schedule = (name: string, expiresAt: number) => {
    // Delay measured now (not at sweep start), so the timer never fires before the deadline
    const remaining = expiresAt - Date.now();
    if (remaining > intervalMs || pending.has(name)) return;
    const t = setTimeout(() => {
      pending.delete(name);
      enqueue(() => deleteIfExpired(dir, name, ttlMs));
    }, Math.max(0, Math.ceil(remaining)) + 1);
    t.unref();
    pending.set(name, t);
  };

  const run = () => enqueue(() => sweepUploads(dir, ttlMs, Date.now(), schedule));
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
    idle: async () => {
      let last: Promise<unknown>;
      do {
        last = chain;
        await last;
      } while (last !== chain);
    },
  };
}

/**
 * GET/HEAD /temp/:name — serves only upload files (exact name match on the decoded param) that are not
 * past their TTL. Anything else under /temp is a 404.
 */
export function serveUpload(dir: string, ttlMs = UPLOAD_TTL_MS) {
  return (req: Request, res: Response) => {
    const name = req.params.name;
    const notFound = () => {
      if (!res.headersSent) res.status(404).end();
    };
    if (typeof name !== "string" || !UPLOAD_FILE_RE.test(name)) return notFound();
    fs.lstat(path.join(dir, name), (err, st) => {
      if (err || !st.isFile() || remainingMs(st.mtimeMs, ttlMs, Date.now()) <= 0) return notFound();
      res.setHeader("Cache-Control", "no-store, private");
      res.sendFile(name, { root: dir, dotfiles: "deny", cacheControl: false }, (sendErr) => {
        if (sendErr) notFound();
      });
    });
  };
}
