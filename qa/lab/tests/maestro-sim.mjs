// Flow simulator for maestro-selectors.test.sh: runs a flow's own YAML and JS against a fake device with the Maestro
// 2.11 semantics the boot flows rely on (`when` conditions, `repeat` times/while, `retry` maxRetries <= 3, lookups that
// wait for the element, selector regex options). The YAML is read by structure, so reordering keys or steps doesn't
// break it; anything it doesn't model (YAML, commands, selector keys, subflow files) fails with the flow's line.
// Usage: node maestro-sim.mjs <boot|toggle> FLOW CLIENT_APP_DIR -> one "<name>\t<ok|FAIL>\t<detail>" line per scenario
import fs from "node:fs";

const [scenario, flowFile, clientApp] = process.argv.slice(2);

// ── YAML subset: block maps and sequences of single-command maps, plain or quoted scalars ──
const lineOf = new WeakMap(); // parsed map or sequence item -> "file:line"

function readFlow(file) {
  const all = fs.readFileSync(file, "utf8").split("\n");
  const start = all.indexOf("---") + 1;
  const lines = all.map((raw, n) => ({ raw, n: n + 1 })).slice(start)
    .filter(({ raw }) => !/^\s*(#.*)?$/.test(raw))
    .map(({ raw, n }) => ({ indent: raw.search(/\S/), text: raw.trim(), at: `${file}:${n}` }));
  let i = 0;
  const fail = (line, message) => { throw new Error(`${line.at}: ${message}`); };
  const scalar = (line, v) => {
    if (v.startsWith('"')) return JSON.parse(v);
    if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
    // Maestro's parser rejects these in an unquoted value (`maestro check-syntax`: "Parsing Failed")
    return /: | #/.test(v) ? fail(line, `quote this value (": " or " #" in a plain scalar): ${v}`) : v;
  };
  const entry = (line, text, indent, target) => {
    const m = text.match(/^([A-Za-z]\w*):(?:\s+(.+))?$/) || fail(line, `unsupported YAML: ${text}`);
    target[m[1]] = m[2] !== undefined ? scalar(line, m[2]) : i < lines.length && lines[i].indent > indent ? block() : null;
  };
  const block = () => {
    const indent = lines[i].indent;
    const isItem = () => i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ");
    if (isItem()) {
      const items = [];
      while (isItem()) {
        const item = {};
        const line = lines[i++];
        lineOf.set(item, line.at);
        entry(line, line.text.slice(2), indent + 2, item);
        while (i < lines.length && lines[i].indent === indent + 2) { const l = lines[i++]; entry(l, l.text, indent + 2, item); }
        items.push(item);
      }
      return items;
    }
    const map = {};
    lineOf.set(map, lines[i].at);
    while (i < lines.length && lines[i].indent === indent && !isItem()) { const l = lines[i++]; entry(l, l.text, indent, map); }
    return map;
  };
  const flow = block();
  if (i < lines.length) fail(lines[i], "unexpected indentation");
  return flow;
}

// ── Mini Maestro ──
const OPTIONAL_LOOKUP_MS = 7000; // a `when: visible` that finds nothing gives up after this
const LOOKUP_MS = 17000; // tapOn / assertVisible wait this long for the element
const STEP_MS = 1000; // any other device step
const POLL_MS = 500;
const SELECTOR_KEYS = ["id", "text"];
class FlowFailure extends Error {} // the device didn't do what the flow expects: what `retry` retries

// Maestro 2.11 compiles text and id selectors with IGNORE_CASE, DOT_MATCHES_ALL and MULTILINE and matches the whole
// value (or the value with line breaks read as spaces). Those options are always on, so a leading Java inline flag
// group of them, e.g. "(?s)", changes nothing and is dropped: JavaScript has no such syntax.
const matches = (pattern, value) => {
  if (value === undefined) return false;
  const re = new RegExp(`(?:${pattern.replace(/^\(\?[ism]+\)/, "")})(?![\\s\\S])`, "simy");
  const whole = (v) => { re.lastIndex = 0; return re.test(v); };
  return value === pattern || whole(value) || whole(value.replace(/\n/g, " "));
};

const flowError = (node, message) => new Error(`${lineOf.get(node) ?? flowFile}: ${message}`);
const checkKeys = (node, allowed, what) => {
  const unknown = Object.keys(node).filter((key) => !allowed.includes(key));
  if (unknown.length) throw flowError(node, `${what}: ${unknown.join(", ")} not simulated (only ${allowed.join(", ")})`);
};

// skippableSubflows: `runFlow: <file>` steps another check covers; any other subflow file fails the run
function runFlow(commands, device, { skippableSubflows = [] } = {}) {
  const output = {};
  const clock = { now: () => device.now };
  const js = (expr) => new Function("output", "Date", `"use strict"; return (${expr});`)(output, clock);
  const value = (v) => {
    if (typeof v !== "string") return v;
    const whole = v.match(/^\$\{([^$]*)\}$/);
    return whole ? js(whole[1]) : v.replace(/\$\{([^$]*)\}/g, (_, expr) => js(expr));
  };
  const selector = (s, extraKeys = []) => {
    if (typeof s === "string") return { text: s };
    checkKeys(s, [...SELECTOR_KEYS, ...extraKeys], "selector");
    return { id: value(s.id), text: value(s.text) };
  };
  const describe = (s) => JSON.stringify(selector(s, ["optional"]));
  const isVisible = (s, extraKeys) => {
    const { id, text } = selector(s, extraKeys);
    return device.elements().some((e) => (!id || matches(id, e.id)) && (!text || matches(text, e.text)));
  };
  const waitFor = (check, timeoutMs) => {
    for (const end = device.now + timeoutMs; !check(); device.tick(POLL_MS)) if (device.now >= end) return false;
    return true;
  };
  // Maestro's order: platform, script (`true`), visible, notVisible
  const condition = (c) => {
    checkKeys(c, ["platform", "true", "visible", "notVisible"], "condition");
    return (!c.platform || c.platform.toLowerCase() === device.platform)
      && (!("true" in c) || Boolean(value(c.true)))
      && (!c.visible || waitFor(() => isVisible(c.visible), OPTIONAL_LOOKUP_MS))
      && (!c.notVisible || waitFor(() => !isVisible(c.notVisible), OPTIONAL_LOOKUP_MS));
  };
  const step = () => device.tick(STEP_MS);
  const commandsByName = {
    launchApp: step, openLink: step, waitForAnimationToEnd: step, pressKey: step, swipe: step,
    evalScript: (arg) => { value(arg); },
    runFlow: (arg, command) => {
      if (typeof arg === "string") {
        if (skippableSubflows.includes(arg)) return;
        throw flowError(command, `runFlow ${arg}: subflow file not simulated`);
      }
      checkKeys(arg, ["when", "commands"], "runFlow");
      if (!arg.when || condition(arg.when)) run(arg.commands);
    },
    tapOn: (arg) => {
      const optional = arg.optional === "true";
      if (!waitFor(() => isVisible(arg, ["optional"]), optional ? OPTIONAL_LOOKUP_MS : LOOKUP_MS)) {
        if (optional) return;
        throw new FlowFailure(`tapOn ${describe(arg)}: not found`);
      }
      device.tap(selector(arg, ["optional"]));
      step();
    },
    assertVisible: (arg) => {
      if (!waitFor(() => isVisible(arg), LOOKUP_MS)) throw new FlowFailure(`assertVisible ${describe(arg)}`);
    },
    assertTrue: (arg) => { if (!value(arg)) throw new FlowFailure(`assertTrue ${arg}`); },
    extendedWaitUntil: (arg) => {
      checkKeys(arg, ["visible", "notVisible", "timeout"], "extendedWaitUntil");
      const met = () => (!arg.visible || isVisible(arg.visible)) && (!arg.notVisible || !isVisible(arg.notVisible));
      if (!waitFor(met, Number(value(arg.timeout))))
        throw new FlowFailure(`extendedWaitUntil ${describe(arg.visible || arg.notVisible)}: timed out`);
    },
    repeat: (arg) => {
      checkKeys(arg, ["times", "while", "commands"], "repeat");
      const times = arg.times === undefined ? Infinity : Number(value(arg.times));
      for (let n = 0; n < times && (!arg.while || condition(arg.while)); n++) {
        if (n === 10000) throw new Error("repeat never ends");
        run(arg.commands);
      }
    },
    retry: (arg) => {
      checkKeys(arg, ["maxRetries", "commands"], "retry");
      const attempts = Math.min(arg.maxRetries === undefined ? 1 : Number(value(arg.maxRetries)), 3) + 1;
      for (let attempt = 1; ; attempt++) {
        try { return run(arg.commands); } catch (e) { if (!(e instanceof FlowFailure) || attempt === attempts) throw e; }
      }
    },
  };
  const run = (list) => list.forEach((command) => {
    const [name, arg] = Object.entries(command)[0];
    if (!commandsByName[name]) throw flowError(command, `unsupported command: ${name}`);
    commandsByName[name](arg, command);
  });
  try { run(commands); return { output, failure: null }; } catch (e) {
    if (e instanceof FlowFailure) return { output, failure: e.message };
    throw e;
  }
}

// ── Fake devices ──
const device = (platform, elements, tap) => {
  const d = { platform, now: 0, due: [], elements: () => elements(d), tap: (sel) => tap(d, sel) };
  d.later = (ms, effect) => d.due.push({ at: d.now + ms, effect });
  d.tick = (ms) => {
    d.now += ms;
    d.due.filter((e) => e.at <= d.now).forEach((e) => e.effect());
    d.due = d.due.filter((e) => e.at > d.now);
  };
  return d;
};

// Launcher that shows the local server, comes back after the first pick and then stalls on the download
const SERVER_ENTRY = "http://10.0.2.2:8081";
const DOWNLOAD_MS = 30000;
function launcherComesBackThenStalls() {
  const state = { launcher: true, picks: 0 };
  const d = device(
    "android",
    () => (state.launcher ? [{ text: "Development servers" }, { text: SERVER_ENTRY }] : [{ text: "Downloading 55.0%..." }]),
    (dev, sel) => {
      if (!matches(sel.text || "", SERVER_ENTRY)) return;
      state.launcher = false;
      if (++state.picks === 1) dev.later(DOWNLOAD_MS, () => { state.launcher = true; });
    },
  );
  return { d, state };
}

// InitialScreen (then home) whose language toggle obeys fate(n) for its n-th tap: "ok", "lost" or "late"
const LATE_TAP_MS = 12000; // a late switch shows after the flow's 10 s wait for it (and the tap's own step)
function onboarding(startLang, fate) {
  const load = (f) => new Function(fs.readFileSync(f, "utf8").replace(/^export default/m, "return").replace(/\}\s*as const;\s*$/, "}"))();
  const titles = { en: load(`${clientApp}/i18n/en.ts`).initialTitle, es: load(`${clientApp}/i18n/es.ts`).initialTitle };
  const state = { lang: startLang, home: false, taps: 0 };
  const switchLang = () => { state.lang = state.lang === "en" ? "es" : "en"; };
  const d = device(
    "ios",
    () => (state.home ? [{ id: "join-game-button" }] : [
      { id: "initial-screen" }, { id: "initial-title", text: titles[state.lang] }, { id: "language-toggle" },
      { id: "initial-continue-button" },
    ]),
    (dev, sel) => {
      if (sel.id && matches(sel.id, "initial-continue-button")) state.home = true;
      if (!sel.id || !matches(sel.id, "language-toggle")) return;
      const tapFate = fate(++state.taps);
      if (tapFate === "ok") switchLang();
      if (tapFate === "late") dev.later(LATE_TAP_MS, switchLang);
    },
  );
  return { d, state };
}

// ── Scenarios ──
const report = (name, pass, detail) => console.log(`${name}\t${pass ? "ok" : "FAIL"}\t${detail}`);

function bootScenarios(flow) {
  // The deadline is absolute: the poll under way when it passes (its lookups, at most one server pick) may finish later
  const POLL_OVERRUN_MS = 30000;
  const { d, state } = launcherComesBackThenStalls();
  const { output, failure } = runFlow(flow, d);
  const boot = output.devClientBoot;
  report("stalled download fails the boot", Boolean(failure), failure || "flow passed");
  report(`launcher picked ${state.picks} times (max ${boot.maxServerPicks})`, state.picks === boot.maxServerPicks && boot.maxServerPicks <= 2, "");
  report(`boot gave up after ${d.now / 1000} s (wait ${boot.timeout / 1000} s)`, d.now <= boot.timeout + POLL_OVERRUN_MS, "the wait restarts on a server pick");
}

function toggleScenarios(flow) {
  // dev-client-boot.yaml has its own scenario (boot)
  const options = { skippableSubflows: ["dev-client-boot.yaml"] };
  const cases = [
    ["English, every tap works", "en", () => "ok", 2],
    ["Spanish, the 2nd tap is lost (it55)", "es", (n) => (n === 2 ? "lost" : "ok"), 3],
    ["English, the 1st tap is lost twice", "en", (n) => (n <= 2 ? "lost" : "ok"), 4],
    // the retry taps again, then the late switch undoes it: the next attempt restores it
    ["English, the 1st tap lands late", "en", (n) => (n === 1 ? "late" : "ok"), 4],
  ];
  for (const [name, lang, fate, taps] of cases) {
    const { d, state } = onboarding(lang, fate);
    const { failure } = runFlow(flow, d, options);
    const pass = !failure && state.home && state.lang === lang && state.taps === taps;
    report(name, pass, failure || `lang=${state.lang} taps=${state.taps} (expected ${taps}) home=${state.home}`);
  }
  const { d, state } = onboarding("es", () => "lost");
  const { failure } = runFlow(flow, d, options);
  report(`a toggle that never responds fails the flow after ${state.taps} taps`, Boolean(failure) && state.taps <= 4, failure || "flow passed");
}

try {
  const scenarios = { boot: bootScenarios, toggle: toggleScenarios };
  if (!scenarios[scenario]) throw new Error(`unknown scenario: ${scenario} (boot or toggle)`);
  scenarios[scenario](readFlow(flowFile));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
