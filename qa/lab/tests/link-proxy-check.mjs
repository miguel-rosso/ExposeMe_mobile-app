// Real-socket checks of qa/lab/link-proxy.mjs (EXP-437), run by link-proxy.test.sh: starts the proxy's command line
// in front of a socket.io server and cuts / restores its link while socket.io clients (websocket transport, like the
// app) use it. The server is an in-process socket.io server on a free port, or a lab server (`--server-port P`, e.g.
// `qa/lab/lab.sh server --port 3105`): the proxy checks are the same, plus on the in-process one that the server side
// of the link drops too. Prints one "ok   - …" / "FAIL - …" line per check; exits 1 when any failed.
// Usage: node qa/lab/tests/link-proxy-check.mjs <link-proxy.mjs> <work dir> [--server-port P]
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [proxyScript, workDir, serverFlag, serverPortArg] = process.argv.slice(2);
const HOST = "127.0.0.1";
const CUT_S = 3;
/** How long the link may take to drop after a cut, or to come back after a restore (socket.io retries every 200-500 ms here) */
const LINK_CHANGE_MS = 2000;
const PROXY_START_MS = 5000;
const POLL_MS = 50;

let failed = 0;
const ok = (name) => console.log(`ok   - ${name}`);
const ko = (name, why) => {
  failed += 1;
  console.log(`FAIL - ${name}${why ? ` (${why})` : ""}`);
};
const check = (name, condition, why) => (condition ? ok(name) : ko(name, why));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Resolves true once `test()` holds, false after `ms` */
const waitFor = async (test, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await sleep(POLL_MS);
  }
  return test();
};

/** `{ status, body }` of an HTTP request, or `{ error }` when the connection failed */
const request = (port, method, urlPath) =>
  new Promise((resolve) => {
    const req = http.request({ host: HOST, port, method, path: urlPath, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (error) => resolve({ error: error.code || error.message }));
    req.end();
  });
const json = (reply) => {
  try {
    return JSON.parse(reply.body);
  } catch {
    return {};
  }
};

/** An in-process socket.io server with GET /health, like the lab server's; tracks its connected sockets */
const startTestServer = async () => {
  const requireServer = createRequire(path.join(HERE, "../../../Server/package.json"));
  const { Server } = requireServer("socket.io");
  const httpServer = http.createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404);
    res.end();
  });
  const sockets = new Set();
  new Server(httpServer).on("connection", (socket) => {
    sockets.add(socket);
    socket.emit("hello");
    socket.on("disconnect", () => sockets.delete(socket));
  });
  await new Promise((done) => httpServer.listen(0, HOST, done));
  return { port: httpServer.address().port, sockets, close: () => httpServer.close() };
};

/** The proxy's command line in front of targetPort; resolves once its ports file is written */
const startProxy = async (targetPort) => {
  const portsFile = path.join(workDir, "ports.json");
  const logFile = path.join(workDir, "link.jsonl");
  const child = spawn(process.execPath, [proxyScript, "--target", String(targetPort), "--ports-file", portsFile, "--log", logFile], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  const started = await waitFor(() => fs.existsSync(portsFile), PROXY_START_MS);
  if (!started) throw new Error("the proxy did not write its ports file");
  const { port, controlPort } = JSON.parse(fs.readFileSync(portsFile, "utf8"));
  const events = () =>
    fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { child, port, controlPort, events };
};

/** A socket.io client like the app's (websocket, endless reconnection), with fast retries; records what it saw */
const connectClient = (port) => {
  const socket = io(`http://${HOST}:${port}`, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 200,
    reconnectionDelayMax: 500,
    forceNew: true,
  });
  const seen = { connects: 0, disconnects: [], connectErrors: 0, hellos: 0 };
  socket.on("connect", () => (seen.connects += 1));
  socket.on("disconnect", (reason) => seen.disconnects.push(reason));
  socket.on("connect_error", () => (seen.connectErrors += 1));
  socket.on("hello", () => (seen.hellos += 1));
  return { socket, seen };
};

const main = async () => {
  const testServer = serverFlag === "--server-port" ? null : await startTestServer();
  const targetPort = testServer ? testServer.port : Number(serverPortArg);
  const where = testServer ? "in-process socket.io server" : `lab server :${targetPort}`;
  console.log(`# against the ${where}`);
  const proxy = await startProxy(targetPort);
  const control = (method, urlPath) => request(proxy.controlPort, method, urlPath);

  // ── Open link: HTTP and socket.io's websocket go through ──
  check("GET /health goes through the proxy", (await request(proxy.port, "GET", "/health")).status === 200);
  const viaProxy = connectClient(proxy.port);
  const direct = connectClient(targetPort); // another player, not behind this device's proxy
  const connected = await waitFor(() => viaProxy.socket.connected && direct.socket.connected, LINK_CHANGE_MS * 2);
  check("a socket.io client connects through the proxy (websocket)", connected);
  if (testServer) {
    await waitFor(() => viaProxy.seen.hellos > 0, LINK_CHANGE_MS);
    check("server events reach the client through the proxy", viaProxy.seen.hellos === 1);
  }

  // ── Cut: the connection in flight drops, new ones are refused, other players stay ──
  const serverSocketsBefore = testServer?.sockets.size;
  const cutReply = await control("POST", `/cut?seconds=${CUT_S}`);
  const cutAt = Date.now();
  check("POST /cut answers 200 with the connections dropped",
    cutReply.status === 200 && json(cutReply).cut === true && json(cutReply).dropped >= 1, cutReply.body);
  const dropped = await waitFor(() => !viaProxy.socket.connected, LINK_CHANGE_MS);
  check("the client behind the proxy loses its connection at once ('transport close')",
    dropped && viaProxy.seen.disconnects[0] === "transport close", viaProxy.seen.disconnects.join(","));
  if (testServer) {
    const serverDropped = await waitFor(() => testServer.sockets.size === serverSocketsBefore - 1, LINK_CHANGE_MS);
    check("the server sees that player disconnect too (its side of the link is closed)", serverDropped);
  }
  await sleep(LINK_CHANGE_MS / 2);
  check("while cut, the client's reconnection attempts fail and it stays offline",
    !viaProxy.socket.connected && viaProxy.seen.connectErrors >= 1, `connectErrors ${viaProxy.seen.connectErrors}`);
  const healthWhileCut = await request(proxy.port, "GET", "/health");
  check("while cut, new connections are refused (GET /health fails)", healthWhileCut.error !== undefined,
    JSON.stringify(healthWhileCut));
  check("while cut, a player not behind the proxy stays connected", direct.socket.connected && direct.seen.disconnects.length === 0);
  const statusWhileCut = json(await control("GET", "/status"));
  check("GET /status reports the cut", statusWhileCut.cut === true && statusWhileCut.cuts === 1, JSON.stringify(statusWhileCut));

  // ── The cut ends on its own: the client reconnects ──
  const back = await waitFor(() => viaProxy.socket.connected, CUT_S * 1000 + LINK_CHANGE_MS);
  const offlineMs = Date.now() - cutAt;
  check(`after ${CUT_S} s the link is back and the client reconnects on its own`,
    back && offlineMs >= CUT_S * 1000 - POLL_MS, `offline ${offlineMs} ms`);
  check("GET /health goes through again", (await request(proxy.port, "GET", "/health")).status === 200);
  const events = proxy.events();
  const cutEvent = events.find((e) => e.event === "cut");
  check("the log records the cut and its timed restore",
    cutEvent?.seconds === CUT_S && cutEvent.dropped >= 1 && events.some((e) => e.event === "restore" && e.by === "timer")
      && events.some((e) => e.event === "refused"),
    JSON.stringify(events.map((e) => e.event)));

  // ── POST /restore ends a cut early ──
  await control("POST", "/cut?seconds=60");
  await waitFor(() => !viaProxy.socket.connected, LINK_CHANGE_MS);
  const restoreReply = await control("POST", "/restore");
  const restored = await waitFor(() => viaProxy.socket.connected, LINK_CHANGE_MS);
  check("POST /restore ends a cut early and the client reconnects",
    restoreReply.status === 200 && restored && proxy.events().some((e) => e.event === "restore" && e.by === "control"));

  // ── Control input ──
  const badCuts = await Promise.all(["/cut", "/cut?seconds=0", "/cut?seconds=601", "/cut?seconds=abc"].map((p) => control("POST", p)));
  check("/cut refuses a missing, zero, too long or non-numeric duration (400) and keeps the link",
    badCuts.every((r) => r.status === 400) && json(await control("GET", "/status")).cut === false,
    badCuts.map((r) => r.status).join(","));
  check("an unknown control route answers 404", (await control("GET", "/cut")).status === 404);

  // ── Stop ──
  viaProxy.socket.close();
  direct.socket.close();
  const exited = new Promise((done) => proxy.child.once("exit", (code) => done(code)));
  proxy.child.kill("SIGTERM");
  const exitCode = await Promise.race([exited, sleep(LINK_CHANGE_MS).then(() => "timeout")]);
  check("SIGTERM stops the proxy (exit 0) and frees its port",
    exitCode === 0 && (await request(proxy.port, "GET", "/health")).error === "ECONNREFUSED", String(exitCode));
  testServer?.close();
};

main()
  .catch((error) => ko("link-proxy checks ran to the end", error.stack))
  .finally(() => process.exit(failed ? 1 : 0));
