import { ChildProcess, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { useTestServer } from "./socketHarness";

// EXP-387: qa/lab/bots.mjs --leave-offline-round, played against the real server in the shape where the leaver is the
// only bot of its process (a second process joining the host's room, like a bot next to a device). That process must
// not end before its seat leave is sent and acked: it once ended "all-out" (pass) at the drop, leaving the host's game
// paused and the seat never left.

const QA_DIR = path.resolve(__dirname, "../../qa");
const BOTS = path.join(QA_DIR, "lab/bots.mjs");
const HAS_QA_DEPS = fs.existsSync(path.join(QA_DIR, "node_modules/socket.io-client"));
const BOTS_TIMEOUT_S = 40;
const CODE_FILE_WAIT_MS = 10_000;
const POLL_MS = 50;

const testServer = useTestServer(); // its url is only known once it listens (read it per run)

// Whatever a run leaves behind (a failed or timed-out test included): bots processes still running, temp dirs
const children: ChildProcess[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  children.splice(0).filter((c) => c.exitCode === null && c.signalCode === null).forEach((c) => c.kill("SIGKILL"));
  tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

interface BotsRun {
  code: number | null;
  summary: { pass: boolean; rooms_detail: { reason: string; errors: string[]; consistency_errors: string[] }[] };
  events: { bot: string; ev: string; payload?: { acked?: boolean } }[];
}

/** Runs bots.mjs with `args` (plus --out); resolves with its exit code, summary and recorded events once it exits. */
function runBots(args: string[], outFile: string): Promise<BotsRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BOTS, "--server", testServer.url, "--out", outFile, "--timeout", String(BOTS_TIMEOUT_S), ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!fs.existsSync(outFile)) return reject(new Error(`bots ${args.join(" ")} wrote no output (rc ${code}): ${stderr}`));
      const { summary, events } = JSON.parse(fs.readFileSync(outFile, "utf8"));
      resolve({ code, summary, events: events[0] });
    });
  });
}

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + CODE_FILE_WAIT_MS;
  while (!fs.existsSync(file) || !fs.readFileSync(file, "utf8")) {
    if (Date.now() > deadline) throw new Error(`no room code in ${file}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return fs.readFileSync(file, "utf8").trim();
}

const evs = (run: BotsRun, bot: string, ev: string) => run.events.filter((e) => e.bot === bot && e.ev === ev);

describe("bots --leave-offline-round, the leaver alone in its process (EXP-387)", () => {
  if (!HAS_QA_DEPS) {
    it.skip("run npm ci in qa/ to enable the offline-leave bots test", () => {});
    return;
  }

  it("the leaver's process ends only after its seat leave is acked, and the host's pause ends with game-over", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bots-offline-leave-"));
    tempDirs.push(dir);
    const codeFile = path.join(dir, "code");
    const host = runBots(["--bots", "1", "--host", "--wait-players", "2", "--code-file", codeFile], path.join(dir, "host.json"));
    const code = await waitForFile(codeFile);
    const leaver = await runBots(
      ["--bots", "1", "--code", code, "--name-prefix", "b-", "--leave-offline-round", "1"], path.join(dir, "leaver.json"),
    );
    const hostRun = await host;

    expect(leaver.summary.rooms_detail[0].errors).toEqual([]);
    expect([leaver.code, leaver.summary.pass, leaver.summary.rooms_detail[0].reason]).toEqual([0, true, "all-out"]);
    expect(evs(leaver, "b-bot1", "seat-leave-sent")).toHaveLength(1);
    expect(evs(leaver, "b-bot1", "seat-leave-done").map((e) => e.payload?.acked)).toEqual([true]);

    expect(hostRun.summary.rooms_detail[0].errors).toEqual([]);
    expect([hostRun.code, hostRun.summary.pass, hostRun.summary.rooms_detail[0].reason]).toEqual([0, true, "game-over"]);
    expect(evs(hostRun, "bot1", "game-paused")).toHaveLength(1);
    expect(evs(hostRun, "bot1", "player-left")).toHaveLength(1);
    expect(evs(hostRun, "bot1", "game-over")).toHaveLength(1);
    expect(evs(hostRun, "bot1", "game-resumed")).toHaveLength(0);
  }, 60_000);
});
