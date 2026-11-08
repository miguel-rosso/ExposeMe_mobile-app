#!/usr/bin/env node
// Lab link proxy (EXP-437): one Android device's own link to the lab server, which a flow can cut mid-game.
//
// Airplane mode doesn't cut `adb reverse` (the emulator reaches the host through adb, not its network), and stopping
// the server deletes the room. So `lab.sh play` points that device's `adb reverse tcp:3000` at this proxy, which
// forwards every TCP connection (HTTP and socket.io's websocket alike) to the server. A cut destroys the connections
// in flight and refuses (resets) new ones for the given seconds, then the proxy accepts again: the device sees a lost
// server link while the server, the room and every other player go on.
//
// Usage: node qa/lab/link-proxy.mjs --target <server port> --ports-file <file> [--log <file.jsonl>]
//                                   [--port <listen port, default any free>] [--control-port <port, default any free>]
// Writes {"port","controlPort"} to --ports-file once both listen (on 127.0.0.1 only). Control (HTTP, loopback):
//   POST /cut?seconds=S   drop every connection and refuse new ones for S seconds (1..MAX_CUT_S); a cut while cut
//                         starts the S seconds over. 200 {"cut":true,"seconds","dropped"}
//   POST /restore         accept again now. 200 {"cut":false}
//   GET  /status          200 {"cut","connections","cuts"}
// --log appends one JSON line per event: listening, cut {seconds, dropped}, restore {by: timer|control}, refused.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

const HOST = "127.0.0.1";
/** The longest cut the control accepts: a flow's whole game is shorter, and a typo must not cut a device for good */
const MAX_CUT_S = 600;
const MS_PER_S = 1000;

/**
 * A TCP proxy from `port` to `targetPort` (both on loopback) that can cut its link. Resolves once listening, with
 * its `port`, `cut(seconds)`, `restore(by)`, `status()` and `close()`.
 */
const startLinkProxy = ({ targetPort, port = 0, log = () => {} }) => {
  const links = new Set(); // { client, upstream } pairs in flight
  let restoreTimer = null;
  let cuts = 0;

  const dropLink = (link) => {
    links.delete(link);
    link.client.destroy();
    link.upstream.destroy();
  };

  const forward = (client) => {
    if (restoreTimer) {
      log({ event: "refused" });
      client.on("error", () => {});
      client.resetAndDestroy();
      return;
    }
    // Half-open allowed on both legs: one side's end is passed on (pipe) without closing the other's replies
    const upstream = net.connect({ port: targetPort, host: HOST, allowHalfOpen: true });
    const link = { client, upstream };
    links.add(link);
    for (const socket of [client, upstream]) {
      socket.on("error", () => dropLink(link));
      socket.on("close", () => dropLink(link));
    }
    client.pipe(upstream);
    upstream.pipe(client);
  };

  const restore = (by) => {
    if (!restoreTimer) return;
    clearTimeout(restoreTimer);
    restoreTimer = null;
    log({ event: "restore", by });
  };

  const cut = (seconds) => {
    const dropped = links.size;
    for (const link of [...links]) dropLink(link);
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => restore("timer"), seconds * MS_PER_S);
    cuts += 1;
    log({ event: "cut", seconds, dropped });
    return dropped;
  };

  const server = net.createServer({ allowHalfOpen: true }, forward);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () =>
      resolve({
        port: server.address().port,
        cut,
        restore,
        status: () => ({ cut: restoreTimer !== null, connections: links.size, cuts }),
        close: () => {
          restore("close");
          for (const link of [...links]) dropLink(link);
          return new Promise((done) => server.close(done));
        },
      })
    );
  });
};

/** Parses /cut's seconds: a number in 1..MAX_CUT_S, else null */
const parseCutSeconds = (value) => {
  if (value === null || !/^\d+(\.\d+)?$/.test(value)) return null;
  const seconds = Number(value);
  return seconds >= 1 && seconds <= MAX_CUT_S ? seconds : null;
};

/** The control endpoint of a proxy (see the header) */
const startControl = (proxy, port = 0) => {
  const reply = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    req.resume(); // a body (Maestro's http.post sends one) is not read
    const url = new URL(req.url, `http://${HOST}`);
    const route = `${req.method} ${url.pathname}`;
    if (route === "POST /cut") {
      const seconds = parseCutSeconds(url.searchParams.get("seconds"));
      if (seconds === null) return reply(res, 400, { error: `seconds must be 1..${MAX_CUT_S}` });
      return reply(res, 200, { cut: true, seconds, dropped: proxy.cut(seconds) });
    }
    if (route === "POST /restore") {
      proxy.restore("control");
      return reply(res, 200, { cut: false });
    }
    if (route === "GET /status") return reply(res, 200, proxy.status());
    return reply(res, 404, { error: "unknown route" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolve(server));
  });
};

// ── Command line ──
const USAGE =
  "usage: node qa/lab/link-proxy.mjs --target <server port> --ports-file <file> [--log <file.jsonl>] [--port N] [--control-port N]";

const parseArgs = (argv) => {
  const options = { port: 0, controlPort: 0 };
  const names = { "--target": "target", "--ports-file": "portsFile", "--log": "log", "--port": "port", "--control-port": "controlPort" };
  for (let i = 0; i < argv.length; i += 2) {
    const name = names[argv[i]];
    if (!name || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}\n${USAGE}`);
    options[name] = argv[i + 1];
  }
  for (const key of ["target", "port", "controlPort"]) {
    const value = Number(options[key]);
    if (!Number.isInteger(value) || value < 0 || value > 65535 || (key === "target" && value === 0)) {
      throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} needs a port\n${USAGE}`);
    }
    options[key] = value;
  }
  if (!options.portsFile) throw new Error(`--ports-file is required\n${USAGE}`);
  return options;
};

const main = async () => {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const log = (entry) => {
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
    if (options.log) fs.appendFileSync(options.log, `${line}\n`);
    else console.log(line);
  };
  const proxy = await startLinkProxy({ targetPort: options.target, port: options.port, log });
  const control = await startControl(proxy, options.controlPort);
  const ports = { port: proxy.port, controlPort: control.address().port };
  // Written whole (rename), so a reader polling for it never sees half of it
  fs.writeFileSync(`${options.portsFile}.tmp`, JSON.stringify(ports));
  fs.renameSync(`${options.portsFile}.tmp`, options.portsFile);
  log({ event: "listening", ...ports, target: options.target });
  const stop = async () => {
    control.close();
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
};

main();
