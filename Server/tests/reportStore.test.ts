import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReportStore, ReportStoreOptions, StoredReport } from "../managers/reportStore";
import { parseWebhookUrl, REPORT_PHOTOS_MAX_BYTES } from "../managers/reportConfig";

// EXP-423: what the server keeps of a report. One JSON line per report, the reported photo kept next to it the moment
// the report is accepted (within a server-wide byte cap), both purged after the retention period, private to the
// server's user, and an optional webhook that is cut off after its timeout and never holds up the report.

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const RETENTION_DAYS = 90;
const WEBHOOK_TIMEOUT_MS = 5_000;
const WEBHOOK = "https://hooks.example.com/reports";
const photoName = (c: string) => `${c.repeat(32)}.jpg`;

let dir: string;
let file: string;

const store = (options: Partial<ReportStoreOptions> = {}) => createReportStore({
  file, retentionMs: RETENTION_DAYS * DAY_MS, photosMaxBytes: REPORT_PHOTOS_MAX_BYTES, webhookUrl: null,
  webhookTimeoutMs: WEBHOOK_TIMEOUT_MS, ...options,
});

const report = (overrides: Partial<StoredReport> = {}): Omit<StoredReport, "photoFile"> => ({
  time: new Date().toISOString(), roomCode: "ABCDEF", round: 1, reporter: "bob", reported: "alice", kind: "photo",
  reason: "sexual", text: null, ...overrides,
});

const storedLines = (): StoredReport[] =>
  fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** A stand-in for an upload in the upload dir (`bytes` long). */
function upload(name: string, bytes = 16): string {
  const uploads = path.join(dir, "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  const source = path.join(uploads, name);
  fs.writeFileSync(source, "x".repeat(bytes), { mode: 0o644 });
  return source;
}

const modeOf = (target: string) => fs.statSync(target).mode & 0o777;

type Store = ReturnType<typeof createReportStore>;
/** As the server does: the reported photo is kept the moment the report is accepted, then the report is saved */
const keepAndSave = (s: Store, r: Omit<StoredReport, "photoFile">, source: string) => s.save(r, s.keepPhoto(source));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "exposeme-reports-"));
  file = path.join(dir, "reports", "reports.jsonl");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("report store: save", () => {
  it("appends one JSON line per report, with the kept photo's name", async () => {
    const s = store();
    await keepAndSave(s, report(), upload(photoName("a")));
    await s.save(report({ kind: "message", round: null, reason: "harassment", text: "you are…" }), null);

    const [photo, message] = storedLines();
    expect(photo).toMatchObject({ roomCode: "ABCDEF", round: 1, reporter: "bob", reported: "alice", kind: "photo", reason: "sexual", text: null });
    expect(photo.photoFile).toBe(photoName("a"));
    expect(message).toMatchObject({ kind: "message", round: null, text: "you are…", photoFile: null });
  });

  it("keeps the photo the moment the report is accepted: an upload deleted right after is still kept", async () => {
    const s = store();
    const source = upload(photoName("b"));
    const saved = keepAndSave(s, report(), source);
    fs.unlinkSync(source); // the game deletes its upload (game over) before the report's line is written
    await saved;
    expect(fs.readFileSync(path.join(s.photosDir, photoName("b")), "utf8")).toBe("x".repeat(16));
    expect(storedLines()[0].photoFile).toBe(photoName("b"));
  });

  it("the same photo reported twice: kept once, named by both reports", async () => {
    const s = store();
    const source = upload(photoName("c"));
    await keepAndSave(s, report(), source);
    await keepAndSave(s, report({ reporter: "carol" }), source);
    expect(fs.readdirSync(s.photosDir)).toEqual([photoName("c")]);
    expect(storedLines().map((r) => r.photoFile)).toEqual([photoName("c"), photoName("c")]);
  });

  it("an upload already deleted, or a file not named like an upload: stored without a photo", async () => {
    const s = store();
    await keepAndSave(s, report(), path.join(dir, photoName("d")));
    await keepAndSave(s, report(), upload("notes.txt"));
    expect(storedLines().map((r) => r.photoFile)).toEqual([null, null]);
  });

  it("the photos kept never go over photosMaxBytes: past it, reports are stored without their photo (logged)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = store({ photosMaxBytes: 100 });
    await keepAndSave(s, report(), upload(photoName("1"), 60));
    await keepAndSave(s, report({ round: 2 }), upload(photoName("2"), 60));
    await keepAndSave(s, report({ round: 3 }), upload(photoName("3"), 40));
    expect(storedLines().map((r) => r.photoFile)).toEqual([photoName("1"), null, photoName("3")]);
    expect(fs.readdirSync(s.photosDir).sort()).toEqual([photoName("1"), photoName("3")]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("REPORT_PHOTOS_MAX_BYTES"));
    expect(warn).toHaveBeenCalledTimes(1); // once, not one line per report
  });

  it("counts the photos already on disk at startup towards the cap", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await keepAndSave(store(), report(), upload(photoName("5"), 80));
    const restarted = store({ photosMaxBytes: 100 });
    await keepAndSave(restarted, report({ round: 2 }), upload(photoName("6"), 40));
    expect(storedLines()[1].photoFile).toBeNull();
  });

  it("a photo that appears in the photos directory after the store read it: kept (EEXIST), its name returned", async () => {
    const s = store();
    expect(s.keepPhoto(upload(photoName("0")))).toBe(photoName("0")); // the store has read the directory now
    const source = upload(photoName("c"));
    fs.linkSync(source, path.join(s.photosDir, photoName("c"))); // e.g. another process kept it meanwhile
    expect(s.keepPhoto(source)).toBe(photoName("c"));
    await s.save(report(), photoName("c"));
    await s.purge();
    expect(fs.existsSync(path.join(s.photosDir, photoName("c")))).toBe(true);
  });

  it("full photos: the webhook is told once (no report data), until a purge frees room", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const s = store({ photosMaxBytes: 50, webhookUrl: WEBHOOK, fetch: fetchMock, now: () => Date.parse("2026-11-03T12:00:00Z") });
    expect(s.keepPhoto(upload(photoName("1"), 60))).toBeNull();
    expect(s.keepPhoto(upload(photoName("2"), 60))).toBeNull();
    const notices = () => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(notices()).toEqual([{ notice: { kind: "report-photos-full", maxBytes: 50, time: "2026-11-03T12:00:00.000Z" } }]);
    await s.purge(); // nothing kept: there is room again
    expect(s.keepPhoto(upload(photoName("3"), 60))).toBeNull();
    expect(notices()).toHaveLength(2);
  });

  it("keeps the files private to the server's user", async () => {
    const s = store();
    await keepAndSave(s, report(), upload(photoName("7")));
    expect(modeOf(file)).toBe(0o600);
    expect(modeOf(path.dirname(file))).toBe(0o700);
    expect(modeOf(s.photosDir)).toBe(0o700);
    expect(modeOf(path.join(s.photosDir, photoName("7")))).toBe(0o600);
  });

  it("startPurging makes files and directories created otherwise private", async () => {
    fs.mkdirSync(path.join(path.dirname(file), "photos"), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.dirname(file), 0o755);
    fs.writeFileSync(file, "", { mode: 0o644 });
    const photo = path.join(path.dirname(file), "photos", photoName("8"));
    fs.writeFileSync(photo, "kept by an older version", { mode: 0o644 });
    fs.writeFileSync(file, `${JSON.stringify({ ...report(), photoFile: photoName("8") })}\n`);
    const s = store();
    const purging = s.startPurging();
    purging.stop();
    await s.purge(); // after the startup purge
    expect(modeOf(path.dirname(file))).toBe(0o700);
    expect(modeOf(path.join(path.dirname(file), "photos"))).toBe(0o700);
    expect(modeOf(file)).toBe(0o600);
    expect(modeOf(photo)).toBe(0o600);
  });
});

describe("report store: retention", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const daysAgo = (days: number) => new Date(now - days * DAY_MS).toISOString();

  it("purges the reports older than the retention period, and their photos", async () => {
    const s = store({ now: () => now });
    await keepAndSave(s, report({ time: daysAgo(RETENTION_DAYS + 1), reporter: "old" }), upload(photoName("1")));
    await keepAndSave(s, report({ time: daysAgo(RETENTION_DAYS - 1), reporter: "recent" }), upload(photoName("2")));
    fs.writeFileSync(path.join(s.photosDir, photoName("9")), "no report names it");
    fs.writeFileSync(path.join(s.photosDir, "README.txt"), "not an upload: never touched");
    fs.appendFileSync(file, "not json\n");

    await s.purge();

    expect(storedLines().map((r) => r.reporter)).toEqual(["recent"]);
    expect(fs.readdirSync(s.photosDir).sort()).toEqual([photoName("2"), "README.txt"]);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it("nothing to drop: the file is left as it is", async () => {
    const s = store({ now: () => now });
    await s.save(report({ time: daysAgo(1) }), null);
    const before = fs.statSync(file).ino;
    await s.purge();
    expect(fs.statSync(file).ino).toBe(before);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it("streams a large file line by line", async () => {
    const s = store({ now: () => now });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = Array.from({ length: 20_000 }, (_, i) =>
      JSON.stringify({ ...report({ time: daysAgo(i % 2 ? RETENTION_DAYS + 1 : 1), reporter: `p${i}` }), photoFile: null }));
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    await s.purge();
    expect(storedLines()).toHaveLength(10_000);
    expect(storedLines().every((r) => Number(r.reporter.slice(1)) % 2 === 0)).toBe(true);
  });

  it("a purge running while a report is saved never takes its photo for an unreferenced one", async () => {
    const s = store({ now: () => now });
    const purged = s.purge(); // queued first: it reads the file before the new line is written
    const saved = keepAndSave(s, report({ time: daysAgo(0) }), upload(photoName("4")));
    await Promise.all([purged, saved]);
    expect(fs.existsSync(path.join(s.photosDir, photoName("4")))).toBe(true);
  });

  it("a stale tmp file left by a crash never passes its mode on", async () => {
    const s = store({ now: () => now });
    await s.save(report({ time: daysAgo(RETENTION_DAYS + 1) }), null);
    await s.save(report({ time: daysAgo(1) }), null);
    fs.writeFileSync(`${file}.tmp`, "half a line", { mode: 0o644 });
    await s.purge();
    expect(storedLines()).toHaveLength(1);
    expect(modeOf(file)).toBe(0o600);
  });

  it("flush resolves once every save and purge asked for is done", async () => {
    const s = store({ now: () => now });
    void s.save(report({ time: daysAgo(1) }), null);
    void s.purge();
    void s.save(report({ time: daysAgo(1), reporter: "last" }), null);
    await s.flush();
    expect(storedLines().map((r) => r.reporter)).toEqual(["bob", "last"]);
  });

  it("nothing stored yet: purging creates nothing", async () => {
    await store().purge();
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });

  it("startPurging purges at once and then hourly", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const clock = { value: now };
    const s = store({ now: () => clock.value });
    await s.save(report({ time: new Date(clock.value).toISOString() }), null);
    const purging = s.startPurging();
    await s.purge(); // after the startup purge, which keeps it
    expect(storedLines()).toHaveLength(1);
    clock.value += RETENTION_DAYS * DAY_MS + 1;
    vi.advanceTimersByTime(HOUR_MS - 1);
    await s.save(report({ time: new Date(clock.value).toISOString(), reporter: "later" }), null);
    expect(storedLines()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(storedLines().map((r) => r.reporter)).toEqual(["later"]));
    purging.stop();
  });
});

describe("report store: webhook", () => {
  it("POSTs { report } as JSON, without the photo bytes, with an abort signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const s = store({ webhookUrl: WEBHOOK, fetch: fetchMock });
    await keepAndSave(s, report(), upload(photoName("e")));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    // Wrapped: no top-level `text` a chat webhook would post as its message
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body)).toEqual(["report"]);
    expect(body.report).toEqual(storedLines()[0]);
    expect(init.body as string).not.toContain("x".repeat(16)); // the file's contents never go out
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("gives up on a webhook that doesn't answer within its timeout, and never waits for it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let signal: AbortSignal | undefined;
    // Never answers: only the abort ends it
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal!;
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const s = store({ webhookUrl: WEBHOOK, fetch: fetchMock as unknown as typeof fetch });

    await s.save(report(), null); // resolves with the webhook still pending
    expect(storedLines()).toHaveLength(1);
    expect(signal!.aborted).toBe(false);

    vi.advanceTimersByTime(WEBHOOK_TIMEOUT_MS - 1);
    expect(signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal!.aborted).toBe(true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("Report webhook failed: AbortError"));
  });

  it("a failing webhook is only logged: the report is stored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = store({ webhookUrl: WEBHOOK, fetch: vi.fn().mockResolvedValue(new Response(null, { status: 500 })) });
    await s.save(report(), null);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("Report webhook answered 500"));
    expect(storedLines()).toHaveLength(1);
  });

  it("no webhook configured: nothing is sent", async () => {
    const fetchMock = vi.fn();
    await store({ fetch: fetchMock }).save(report(), null);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("parseWebhookUrl", () => {
  it("unset or blank → none", () => {
    expect(parseWebhookUrl(undefined)).toBeNull();
    expect(parseWebhookUrl("  ")).toBeNull();
  });

  it("an http(s) URL → it", () => {
    expect(parseWebhookUrl(` ${WEBHOOK} `)).toBe(WEBHOOK);
    expect(parseWebhookUrl("http://localhost:9000/hook")).toBe("http://localhost:9000/hook");
  });

  it("anything else → none, logged without echoing the value (it may hold a token)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseWebhookUrl("ftp://example.com/secret-token")).toBeNull();
    expect(parseWebhookUrl("not a url secret-token")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("secret-token");
  });
});
