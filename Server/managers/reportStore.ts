import fs from "fs";
import path from "path";
import readline from "readline";
import { findServerRoot } from "../middlewares/upload";
import type { ReportKind, ReportReason } from "./contentReports";
import { REPORT_PHOTOS_MAX_BYTES, REPORT_RETENTION_DAYS, REPORT_WEBHOOK_URL } from "./reportConfig";

// ── Report storage (EXP-423) ──
// Every accepted report-content is appended as one JSON line to REPORTS_FILE (default Server/reports/reports.jsonl),
// and a reported photo is kept in the `photos` directory next to it (a hard link to its upload, a copy across disks),
// taken the moment the report is accepted, so the operator can still review it after the game deleted its upload
// (game over, or the 30-min TTL at the latest). The photos kept take at most REPORT_PHOTOS_MAX_BYTES: past that a
// report is stored without its photo (logged, and the webhook told once). Reports and their photos are purged once older than
// REPORT_RETENTION_DAYS (default 90), checked hourly. When REPORT_WEBHOOK_URL is set, each report is also POSTed there
// as JSON `{ report }` (no photo bytes), with a timeout; a slow or failing webhook never delays the game.
// Both paths are git-ignored (Server/.gitignore) and private to the server's user: reports hold personal data and
// possibly abusive content.

/** One line of the reports file, also the webhook's `report`. */
export interface StoredReport {
  /** ISO time the server accepted the report */
  time: string;
  roomCode: string;
  /** The reported photo's round; null for a message */
  round: number | null;
  reporter: string;
  reported: string;
  kind: ReportKind;
  reason: ReportReason;
  /** The reported message; null for a photo */
  text: string | null;
  /** The kept photo's file name in the photos directory; null for a message, or when no photo could be kept */
  photoFile: string | null;
}

export interface ReportStoreOptions {
  /** The JSON-lines file; the photos go to `photos/` in its directory */
  file: string;
  retentionMs: number;
  /** Bytes the kept photos may take in all */
  photosMaxBytes: number;
  /** Where to POST each report, or null for no notification */
  webhookUrl: string | null;
  webhookTimeoutMs: number;
  /** Injected in tests */
  fetch?: typeof fetch;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60_000;
/** How often stored reports are checked for the retention period (and once at startup): kept at most an hour over it. */
const PURGE_INTERVAL_MS = 60 * 60_000;
/** A webhook that hasn't answered by then is given up on (the report is stored anyway). */
const WEBHOOK_TIMEOUT_MS = 5_000;
// Owner-only: reports hold personal data
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
/** The names POST /upload gives photos (controllers/UploadController.ts): the only files the photos directory holds */
const PHOTO_NAME_RE = /^[0-9a-f]{32}\.(?:jpg|png|webp)$/;
/** A purge writes the kept lines in chunks of about this many characters: memory stays bounded for any file size */
const PURGE_WRITE_CHUNK = 64 * 1024;

const errorCode = (err: unknown) => (err as NodeJS.ErrnoException)?.code;
const isMissing = (err: unknown) => errorCode(err) === "ENOENT";

/** The report on a line of the reports file, or null when it is malformed or undated. */
function parseLine(line: string): StoredReport | null {
  try {
    const report = JSON.parse(line) as StoredReport;
    return Number.isFinite(Date.parse(report?.time)) ? report : null;
  } catch {
    return null;
  }
}

/** Sets `mode` on `target` if it exists. */
function chmodIfPresent(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}

export function createReportStore({
  file, retentionMs, photosMaxBytes, webhookUrl, webhookTimeoutMs, fetch: fetchFn = fetch, now = Date.now,
}: ReportStoreOptions) {
  const reportsDir = path.dirname(file);
  const photosDir = path.join(reportsDir, "photos");
  // Appends and purges run one at a time, so a purge never rewrites the file under an append
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = (label: string, task: () => Promise<unknown>): Promise<void> => {
    const run = chain.then(task).then(() => undefined, (err) => console.error(`Report ${label} failed:`, err));
    chain = run;
    return run;
  };
  // Photos kept for a report whose line isn't written yet: a purge never takes them for unreferenced ones
  const pendingPhotos = new Set<string>();

  /** The photos kept, by name, with their size (read from disk the first time and at each purge, kept up to date between) */
  let keptPhotos: Map<string, number> | null = null;
  const photosOnDisk = (): Map<string, number> => {
    if (keptPhotos) return keptPhotos;
    keptPhotos = new Map();
    let names: string[] = [];
    try {
      names = fs.readdirSync(photosDir);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    for (const name of names.filter((n) => PHOTO_NAME_RE.test(n))) keptPhotos.set(name, fs.statSync(path.join(photosDir, name)).size);
    return keptPhotos;
  };
  const keptBytes = () => [...photosOnDisk().values()].reduce((sum, size) => sum + size, 0);

  /** POSTs `body` to the webhook, if any; never awaited by the game, and cut off after the timeout. */
  const post = (body: object): void => {
    if (!webhookUrl) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), webhookTimeoutMs);
    fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then((res) => { if (!res.ok) console.warn(`Report webhook answered ${res.status}`); })
      .catch((err: Error) => console.warn(`Report webhook failed: ${err.name}`))
      .finally(() => clearTimeout(timer));
  };

  // Wrapped, so no field of it (the reported text) is read as the message of a chat webhook
  const notify = (report: StoredReport): void => post({ report });

  // The log and the webhook were told the photos are full: once, until a purge frees room again (no line per report)
  let fullNoticeSent = false;
  const photosFull = (): void => {
    if (fullNoticeSent) return;
    fullNoticeSent = true;
    console.warn("[reports] the reported photos kept reach REPORT_PHOTOS_MAX_BYTES: reports are stored without their photo");
    post({ notice: { kind: "report-photos-full", maxBytes: photosMaxBytes, time: new Date(now()).toISOString() } });
  };

  /** Links `source` as the kept photo `target` (a copy across disks); false when the upload is already gone. */
  const linkOrCopy = (source: string, target: string): boolean => {
    try {
      fs.linkSync(source, target);
    } catch (err) {
      if (isMissing(err)) return false;
      if (errorCode(err) === "EEXIST") return true; // kept already (e.g. by a previous process)
      if (errorCode(err) !== "EXDEV") throw err;
      try {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      } catch (copyErr) {
        if (isMissing(copyErr)) return false;
        if (errorCode(copyErr) !== "EEXIST") throw copyErr;
      }
    }
    return true;
  };

  /**
   * Keeps the reported upload at `source` in the photos directory, right now (before the game can delete it): a hard
   * link, or a copy when the photos are on another disk. Its name there, to pass to `save`, or null when it is already
   * gone, isn't an upload, or would take the photos over photosMaxBytes (logged, the webhook told once). Until `save`
   * writes the report, no purge deletes it.
   */
  const keepPhoto = (source: string): string | null => {
    const name = path.basename(source);
    if (!PHOTO_NAME_RE.test(name)) return null;
    const kept = photosOnDisk();
    if (kept.has(name)) return pending(name); // reported before: one copy is enough
    let size: number;
    try {
      size = fs.statSync(source).size;
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    if (keptBytes() + size > photosMaxBytes) {
      photosFull();
      return null;
    }
    fs.mkdirSync(photosDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const target = path.join(photosDir, name);
    if (!linkOrCopy(source, target)) return null;
    fs.chmodSync(target, PRIVATE_FILE_MODE);
    kept.set(name, fs.statSync(target).size);
    return pending(name);
  };

  /** `name` waits for its report's line: no purge takes it for an unreferenced photo until `save` writes it. */
  const pending = (name: string): string => {
    pendingPhotos.add(name);
    return name;
  };
  /**
   * Stores a report with `photoFile`, the name `keepPhoto` gave its photo (null: none): the line is appended, then the
   * webhook notified. Resolves once stored; failures are logged, never thrown.
   */
  const save = (report: Omit<StoredReport, "photoFile">, photoFile: string | null): Promise<void> => {
    const stored: StoredReport = { ...report, photoFile };
    return enqueue("save", async () => {
      try {
        await fs.promises.mkdir(reportsDir, { recursive: true, mode: PRIVATE_DIR_MODE });
        await fs.promises.appendFile(file, `${JSON.stringify(stored)}\n`, { mode: PRIVATE_FILE_MODE });
      } finally {
        if (photoFile) pendingPhotos.delete(photoFile);
      }
      notify(stored);
    });
  };

  /**
   * Streams the reports file into `${file}.tmp` keeping the reports within the retention period (malformed lines are
   * dropped), and moves it over the file when anything was dropped. The photo names the kept reports use.
   */
  const rewriteFresh = async (cutoff: number): Promise<Set<string | null>> => {
    const referenced = new Set<string | null>();
    let input: fs.ReadStream;
    try {
      await fs.promises.access(file);
      input = fs.createReadStream(file, "utf8");
    } catch (err) {
      if (isMissing(err)) return referenced;
      throw err;
    }
    const next = `${file}.tmp`;
    // A tmp file left by a crash keeps its mode through "w": start from a new one, created private
    await fs.promises.rm(next, { force: true });
    const output = await fs.promises.open(next, "wx", PRIVATE_FILE_MODE);
    let dropped = 0;
    let pending = "";
    try {
      for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
        if (!line) continue;
        const report = parseLine(line);
        if (!report || Date.parse(report.time) < cutoff) { dropped++; continue; }
        referenced.add(report.photoFile);
        pending += `${line}\n`;
        if (pending.length >= PURGE_WRITE_CHUNK) { await output.write(pending); pending = ""; }
      }
      await output.write(pending);
    } finally {
      input.destroy();
      await output.close();
    }
    // Written aside, then renamed over: a crash halfway never leaves a half-written file
    if (dropped > 0) await fs.promises.rename(next, file);
    else await fs.promises.unlink(next);
    return referenced;
  };

  /** Deletes every kept photo that no kept report names (only upload-named files: nothing else is ever touched). */
  const deleteUnreferencedPhotos = async (referenced: Set<string | null>): Promise<void> => {
    keptPhotos = null; // read again: also finds photos a previous process kept without writing their report
    const kept = photosOnDisk();
    for (const name of [...kept.keys()]) {
      if (referenced.has(name) || pendingPhotos.has(name)) continue;
      try {
        await fs.promises.unlink(path.join(photosDir, name));
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
      kept.delete(name);
    }
  };

  /** Drops the reports older than the retention period, and every kept photo no kept report names. */
  const purge = (): Promise<void> =>
    enqueue("purge", async () => {
      await deleteUnreferencedPhotos(await rewriteFresh(now() - retentionMs));
      if (keptBytes() < photosMaxBytes) fullNoticeSent = false;
    });

  /** Resolves once every save and purge asked for so far is done (tests, before deleting the files). */
  const flush = (): Promise<void> => chain.then(() => undefined);

  /** Makes the reports file, the kept photos and their directories private (also when created otherwise before). */
  const lockDown = (): void => {
    chmodIfPresent(reportsDir, PRIVATE_DIR_MODE);
    chmodIfPresent(photosDir, PRIVATE_DIR_MODE);
    chmodIfPresent(file, PRIVATE_FILE_MODE);
    for (const name of photosOnDisk().keys()) chmodIfPresent(path.join(photosDir, name), PRIVATE_FILE_MODE);
  };

  /** At startup: locks the files down and purges, then purges every `intervalMs` (the timer keeps nothing alive). */
  const startPurging = (intervalMs = PURGE_INTERVAL_MS): { stop: () => void } => {
    try {
      lockDown();
    } catch (err) {
      console.error("Report files not locked down:", errorCode(err));
    }
    void purge();
    const timer = setInterval(() => { void purge(); }, intervalMs);
    timer.unref();
    return { stop: () => clearInterval(timer) };
  };

  return { keepPhoto, save, purge, flush, startPurging, photosDir };
}

export type ReportStore = ReturnType<typeof createReportStore>;

/** The server's report store, configured from the environment (REPORTS_FILE, REPORT_* in managers/reportConfig). */
export const reportStore = createReportStore({
  file: process.env.REPORTS_FILE || path.join(findServerRoot(__dirname), "reports", "reports.jsonl"),
  retentionMs: REPORT_RETENTION_DAYS * DAY_MS,
  photosMaxBytes: REPORT_PHOTOS_MAX_BYTES,
  webhookUrl: REPORT_WEBHOOK_URL,
  webhookTimeoutMs: WEBHOOK_TIMEOUT_MS,
});
