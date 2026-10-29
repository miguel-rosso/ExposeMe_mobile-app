// Flow simulator for maestro-selectors.test.sh and maestro-timing.test.sh: runs a flow's own YAML and JS against a fake
// device with the Maestro 2.11 semantics the boot and round flows rely on (`when` conditions, `repeat` times/while,
// `retry` maxRetries <= 3, lookups that wait for the element, conditions that wait less after a command acted on the
// device, selector regex options, `below`, env variables, screen reads that take time). The YAML is read by structure, so reordering keys or steps doesn't break it; anything it
// doesn't model (YAML, commands, selector keys, subflow files) fails with the flow's line.
// Usage: node maestro-sim.mjs <boot|toggle|rounds> FLOW CLIENT_APP_DIR -> one "<name>\t<ok|FAIL>\t<detail>" line per
// scenario
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
    if (v === "[]") return []; // an empty list, e.g. `commands: []`
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
        const text = line.text.slice(2);
        if (/^[A-Za-z]\w*$/.test(text)) item[text] = null; // a command without arguments, e.g. `- stopApp`
        else entry(line, text, indent + 2, item);
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
// A condition (`when`, `while`) waits for its element at most this long, minus the time since the last command that
// may have acted on the device, an evalScript included (Maestro 2.11: Orchestra.adjustedToLatestInteraction, and
// evalScriptCommand always reports a change): 7 s or more after it, a single read
const OPTIONAL_LOOKUP_MS = 7000;
const LOOKUP_MS = 17000; // tapOn / assertVisible wait this long for the element
const STEP_MS = 1000; // any other device step
const POLL_MS = 500;
const SELECTOR_KEYS = ["id", "text", "below"];
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

// skippableSubflows: `runFlow: <file>` steps another check covers; any other subflow file fails the run.
// env: the flow's variables (`maestro test -e KEY=VALUE`)
function runFlow(commands, device, { skippableSubflows = [], env = {} } = {}) {
  const output = {};
  const clock = { now: () => device.now };
  let lastInteraction = -Infinity; // device.now when a command last acted on the device
  const js = (expr) =>
    new Function("output", "Date", ...Object.keys(env), `"use strict"; return (${expr});`)(output, clock, ...Object.values(env));
  const value = (v) => {
    if (typeof v !== "string") return v;
    const whole = v.match(/^\$\{([^$]*)\}$/);
    return whole ? js(whole[1]) : v.replace(/\$\{([^$]*)\}/g, (_, expr) => js(expr));
  };
  const selector = (s, extraKeys = []) => {
    if (typeof s === "string") return { text: s };
    checkKeys(s, [...SELECTOR_KEYS, ...extraKeys], "selector");
    return { id: value(s.id), text: value(s.text), below: s.below && selector(s.below) };
  };
  const TAP_KEYS = ["optional", "waitToSettleTimeoutMs"];
  const describe = (s) => JSON.stringify(selector(s, TAP_KEYS));
  // `below`: some element matching it is higher on screen (smaller y)
  const found = (sel, shown) => shown.filter((e) => (!sel.id || matches(sel.id, e.id)) && (!sel.text || matches(sel.text, e.text))
    && (!sel.below || found(sel.below, shown).some((anchor) => (anchor.y ?? 0) < (e.y ?? 0))));
  // One screen read: what shows when it starts (it may take a while, see device.read)
  const isVisible = (s, extraKeys) => {
    const sel = selector(s, extraKeys);
    return found(sel, device.read(sel)).length > 0;
  };
  const waitFor = (check, timeoutMs) => {
    for (const end = device.now + timeoutMs; !check(); device.tick(POLL_MS)) if (device.now >= end) return false;
    return true;
  };
  // Maestro's order: platform, script (`true`), visible, notVisible
  const condition = (c) => {
    checkKeys(c, ["platform", "true", "visible", "notVisible"], "condition");
    const lookupMs = () => Math.max(0, OPTIONAL_LOOKUP_MS - (device.now - lastInteraction));
    return (!c.platform || c.platform.toLowerCase() === device.platform)
      && (!("true" in c) || Boolean(value(c.true)))
      && (!c.visible || waitFor(() => isVisible(c.visible), lookupMs()))
      && (!c.notVisible || waitFor(() => !isVisible(c.notVisible), lookupMs()));
  };
  const step = () => device.tick(STEP_MS);
  // A command that acts on the device: a step, then conditions wait the full optional lookup again
  const interaction = (act = () => {}) => (arg) => { act(arg); step(); lastInteraction = device.now; };
  const commandsByName = {
    waitForAnimationToEnd: step, takeScreenshot: step,
    launchApp: interaction(), swipe: interaction(),
    // the device reacts to these only if it models them (see the fake devices)
    openLink: interaction((link) => device.openLink?.(link)),
    stopApp: interaction(() => device.stopApp?.()),
    pressKey: interaction((key) => device.pressKey?.(key)),
    evalScript: (arg) => { value(arg); lastInteraction = device.now; },
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
      if (!waitFor(() => isVisible(arg, TAP_KEYS), optional ? OPTIONAL_LOOKUP_MS : LOOKUP_MS)) {
        if (optional) return;
        throw new FlowFailure(`tapOn ${describe(arg)}: not found`);
      }
      interaction(() => device.tap(selector(arg, TAP_KEYS)))();
    },
    assertVisible: (arg) => {
      if (!waitFor(() => isVisible(arg), LOOKUP_MS)) throw new FlowFailure(`assertVisible ${describe(arg)}`);
    },
    assertTrue: (arg) => { // `assertTrue: ${...}` or { condition, label }
      const { condition: cond, label } = typeof arg === "string" ? { condition: arg } : arg;
      if (!value(cond)) throw new FlowFailure(`assertTrue ${label || cond}`);
    },
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
// readMs(device, selector): how long one screen read takes (a fast phone by default); it sees the screen as it starts
const DEFAULT_READ_MS = 500;
const device = (platform, elements, tap, readMs = () => DEFAULT_READ_MS) => {
  const d = { platform, now: 0, due: [], elements: () => elements(d), tap: (sel) => tap(d, sel) };
  d.read = (sel) => { const shown = d.elements(); d.tick(readMs(d, sel)); return shown; };
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

// Android dev client right after the caller's launchApp(clearState), as expo-dev-launcher 58 does it: MainActivity
// starts on a redirect delegate whose onNewIntent drops any intent, so a link sent before it hands over to the launcher
// is lost (EXP-296) and the launcher shows. A link that cold-starts the app loads the bundle and applies its
// __expo_disable_auto_launch for the whole process; a server picked in the launcher carries no such flag, so without
// it the dev menu opens over the app.
const DEV_MENU = { text: "Connected to: http://localhost:8081" };
function androidLinkRaceAfterLaunch() {
  const state = { running: true, screen: "starting", autoLaunchDisabled: false, devMenu: false, devMenuOpened: false, picks: 0 };
  const loadApp = (disablesAutoLaunch) => {
    state.autoLaunchDisabled ||= disablesAutoLaunch;
    state.screen = "app";
    state.devMenu = !state.autoLaunchDisabled;
    state.devMenuOpened ||= state.devMenu;
  };
  const d = device(
    "android",
    () => ({
      starting: [],
      launcher: [{ text: "Development servers" }, { text: SERVER_ENTRY }],
      app: [{ id: "initial-screen" }, ...(state.devMenu ? [DEV_MENU] : [])],
    })[state.screen],
    (dev, sel) => {
      if (state.screen !== "launcher" || !matches(sel.text || "", SERVER_ENTRY)) return;
      state.picks++;
      loadApp(false);
    },
  );
  d.stopApp = () => Object.assign(state, { running: false, screen: "starting", autoLaunchDisabled: false, devMenu: false });
  d.openLink = (link) => {
    if (state.running) { state.screen = "launcher"; return; }
    state.running = true;
    loadApp(/[?&]__expo_disable_auto_launch=1(&|$)/.test(link));
  };
  d.pressKey = (key) => { if (/^back$/i.test(key)) state.devMenu = false; };
  return { d, state };
}

// The dev client fails to load the bundle and shows its error screen (EXP-298, it122: iOS "URL in…" error)
function loadErrorScreen(platform) {
  const d = device(platform, () => [
    { text: "There was a problem loading the project." },
    { text: "This development build encountered the following error:" },
    { text: "Reload" }, { text: "Go home" },
  ], () => {});
  return { d };
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

// A game of `rounds` rounds as the server plays it (phase lengths from GameEngine.ts) on a device whose screen reads take
// readMs(time) each. Records the phase each tap on an option lands in, and by round the screen reads of the scoreboard
// checks: the card wait's that saw the scoreboard, and the card name's and options-under-it's, whose reads that saw no
// scoreboard (`blindChecks`) pass without checking anything.
// ownerRound: the device's photo (its card says so); ownNameRound: its card wrongly shows its own name (EXP-290).
const PHOTO_WAIT_MS = 500; // the owner's upload (a bot's: well under a second)
const PHOTO_LOADING_MS = 1000; // the round photo's loading spinner
const engineMs = (name) => {
  const engine = fs.readFileSync(`${clientApp}/../../Server/managers/GameEngine.ts`, "utf8");
  const m = engine.match(new RegExp(`^const ${name} = ([0-9_]+);`, "m"));
  if (!m) throw new Error(`GameEngine.ts: no ${name}`);
  return Number(m[1].replace(/_/g, ""));
};
function game({ rounds, readMs, username, ownerRound = 0, ownNameRound = 0, cardlessRound = 0 }) {
  const phases = [["photo", PHOTO_WAIT_MS], ["answering", engineMs("ANSWER_TIME")], ["reveal", engineMs("REVEAL_TIME")],
    ["scores", engineMs("SCORE_DISPLAY_TIME")]];
  const roundMs = phases.reduce((sum, [, ms]) => sum + ms, 0);
  const state = { roundMs, phases: Object.fromEntries(phases), taps: [], checks: [], blindChecks: [], final: false };
  const phaseAt = (t) => { // { round (from 1), phase, ms into it }
    const round = Math.floor(t / roundMs) + 1;
    if (round > rounds) return { round: rounds, phase: "over" };
    let into = t % roundMs;
    for (const [phase, ms] of phases) { if (into < ms) return { round, phase, into }; into -= ms; }
  };
  const options = [{ id: "answer-options", y: 2 }, { id: "player-option-bot1", y: 3 }, { id: "player-option-bot2", y: 3 }];
  const cardName = (round) => {
    if (round === ownNameRound) return username;
    return round === ownerRound ? "It was your photo!" : "bot2";
  };
  const card = (round) => (round === cardlessRound ? [] : [
    { id: "score-answer-card" }, { id: "score-answer-name", text: cardName(round) },
  ]);
  const screen = ({ round, phase, into }) => ({
    photo: () => [{ id: "game-waiting-photo" }],
    answering: () => [{ id: "round-progress", y: 1 }, { id: "photo-view" },
      ...(into < PHOTO_LOADING_MS ? [{ id: "photo-loading" }] : []), ...options],
    reveal: () => [{ id: "photo-view" }, ...options],
    scores: () => [{ id: "score-modal" }, { id: "score-round-title", y: 1 }, ...card(round)],
    over: () => (state.final ? [{ id: "final-score-modal" }] : [{ id: "winner-modal" }, { id: "winner-continue" }]),
  })[phase]();
  const scoreboardCheck = (sel) => {
    if (/^score-answer-card\|/.test(sel.id || "")) return "card";
    if (sel.id === "score-answer-name") return "card name";
    return sel.below?.id === "score-round-title" ? "options under it" : null;
  };
  const d = device(
    "android",
    (dev) => screen(phaseAt(dev.now)),
    (dev, sel) => {
      if (matches(sel.id || "", "winner-continue")) state.final = true;
      else if (/^player-option-/.test(sel.id || "")) state.taps.push(phaseAt(dev.now));
    },
    (dev, sel) => {
      const at = phaseAt(dev.now);
      const check = scoreboardCheck(sel);
      if (check && at.phase === "scores") state.checks.push({ round: at.round, check });
      else if (check && check !== "card") state.blindChecks.push({ round: at.round, check }); // the card wait polls
      return readMs(dev.now, state);
    },
  );
  return { d, state, env: { USERNAME: username } };
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

  // EXP-296: the link must reach the dev client (not be dropped after launchApp), so its flags keep the dev menu shut
  const race = androidLinkRaceAfterLaunch();
  const raceRun = runFlow(flow, race.d);
  report("Android: the link loads the app after launchApp without opening the dev menu",
    !raceRun.failure && race.state.screen === "app" && !race.state.devMenuOpened && race.state.picks === 0,
    raceRun.failure || `devMenuOpened=${race.state.devMenuOpened} serverPicks=${race.state.picks}`);

  // EXP-298: the dev client's load error screen ends the wait at once, failing on the assert on `loaded`
  const ERROR_EXIT_MS = 30000; // a couple of polls, far below the 120 s wait
  for (const platform of ["android", "ios"]) {
    const error = loadErrorScreen(platform);
    const errorRun = runFlow(flow, error.d);
    report(`${platform}: the load error screen fails the boot in ${error.d.now / 1000} s`,
      /assertTrue .*devClientBoot\.loaded/.test(errorRun.failure || "") && error.d.now <= ERROR_EXIT_MS,
      errorRun.failure || "flow passed");
  }
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

// Seeded uniform random numbers in [0, 1) (an LCG: the same games on every run)
const seededRandom = (seed) => {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
};

function roundsScenarios(flow) {
  const ROUNDS = 6;
  const USERNAME = "android-a";
  const options = { skippableSubflows: ["wait-game-start.yaml"] };
  const play = (readMs, gameOptions = {}) => {
    const { d, state, env } = game({ rounds: ROUNDS, readMs, username: USERNAME, ownerRound: 2, ...gameOptions });
    const result = runFlow(flow, d, { ...options, env });
    return { state, now: d.now, ...result };
  };
  // Rounds 2 on: the first one starts from the lobby, where the device may well be late for the options
  const LATER_ROUNDS = Array.from({ length: ROUNDS - 1 }, (_, i) => i + 2);
  const missedGuesses = (state) => [1, ...LATER_ROUNDS]
    .filter((round) => !state.taps.some((tap) => tap.round === round && tap.phase === "answering"));
  // Screen reads on the Android emulator (it136, 12-player room): 0.6-3.5 s, ~1.5 s most of the time, and now and then
  // a burst of slow ones (EXP-312, round 6 there: 3.3-3.6 s after its guess) that pushed the scoreboard checks into
  // the next answering phase
  const STEADY_READ_MS = 1500;
  const SLOW_READ_MS = 4000;
  const slowAfterGuess = (round) => (t, { roundMs, phases }) => { // from the round's reveal to its scoreboard's end
    const revealStart = (round - 1) * roundMs + phases.photo + phases.answering;
    return t >= revealStart && t < revealStart + phases.reveal + phases.scores ? SLOW_READ_MS : STEADY_READ_MS;
  };
  const RANDOM_GAMES = 40;
  // Read ranges: it136's usual one, and every read it measured (0.6-3.5 s). The share of games in which a scoreboard
  // without its card fails the flow: on a slower phone more scoreboards go by while it is still busy with the round
  const RANDOM_PROFILES = [
    { range: [600, 2000], minCardlessCaught: 0.9 },
    { range: [600, 3500], minCardlessCaught: 0.6 },
  ];
  const CARDLESS_ROUND = 3;
  // Most guesses must land: a slower phone loses some (the flow can't make a read faster), never by a false failure
  const MAX_MISSED_RANDOM = 0.05;

  // ── Every guess in time, the scoreboard checked while it is up ──
  const cases = [
    [`steady emulator (${STEADY_READ_MS / 1000} s per screen read)`, () => STEADY_READ_MS],
    [`slow reads (${SLOW_READ_MS / 1000} s) through round 3's reveal and scoreboard (it136)`, slowAfterGuess(3)],
  ];
  for (const [name, readMs] of cases) {
    const { state, failure } = play(readMs);
    const missed = missedGuesses(state);
    report(`${name}: the game ends on the results`, !failure && state.final, failure || "no final ranking");
    report(`${name}: every round's guess lands while answering`, missed.length === 0,
      `rounds without a guess in time: ${missed.join(", ")}; taps: ${JSON.stringify(state.taps)}`);
    report(`${name}: no scoreboard check reads after its scoreboard closed`, state.blindChecks.length === 0,
      `checks that saw no scoreboard: ${JSON.stringify(state.blindChecks)}`);
  }
  const steady = play(() => STEADY_READ_MS);
  const uncheckedCards = LATER_ROUNDS.filter((round) => !steady.state.checks.some((c) => c.round === round && c.check === "card"));
  report(`steady emulator: the card is checked on every scoreboard after the first`, uncheckedCards.length === 0,
    `rounds whose card went unchecked: ${uncheckedCards.join(", ")}`);

  // ── Slower phones: no false failure, few lost guesses, enough scoreboards checked ──
  // The flow itself fails when fewer than half the scoreboards (the last aside) were checked, so a game that ends on the
  // results met that floor
  const cardsChecked = (state) => new Set(state.checks.filter((c) => c.check === "card").map((c) => c.round)).size;
  for (const readMs of [2000, 2500]) {
    const { state, failure } = play(() => readMs);
    const missed = missedGuesses(state);
    report(`${readMs / 1000} s per screen read: the game ends on the results (${cardsChecked(state)}/${ROUNDS} scoreboards `
      + "checked), at most one guess lost", !failure && state.final && missed.length <= 1 && state.blindChecks.length === 0,
    `${failure || ""} rounds without a guess in time: ${missed.join(", ")}; blind checks: ${state.blindChecks.length}`);
  }
  // Seeded random reads: the same games on every run. Each game is played again with a scoreboard missing its card,
  // which must fail the flow in most games (a late scoreboard goes unchecked, but never most of them: the floor)
  const randomReads = (seed, [fastest, slowest]) => {
    const random = seededRandom(seed);
    return () => Math.round(fastest + random() * (slowest - fastest));
  };
  for (const { range, minCardlessCaught } of RANDOM_PROFILES) {
    let failures = 0, missed = 0, blind = 0, checked = 0, caught = 0;
    for (let seed = 1; seed <= RANDOM_GAMES; seed++) {
      const { state, failure } = play(randomReads(seed, range));
      if (failure || !state.final) failures++;
      missed += missedGuesses(state).filter((round) => round > 1).length;
      blind += state.blindChecks.length;
      checked += cardsChecked(state);
      const cardless = play(randomReads(seed, range), { cardlessRound: CARDLESS_ROUND });
      if (/score-answer-card/.test(cardless.failure || "")) caught++;
    }
    const laterRounds = RANDOM_GAMES * LATER_ROUNDS.length;
    const name = `${RANDOM_GAMES} games with random ${range[0] / 1000}-${range[1] / 1000} s screen reads`;
    report(`${name}: no failed flow, no blind check, at most ${MAX_MISSED_RANDOM * 100}% of the guesses after round 1 lost`,
      failures === 0 && blind === 0 && missed <= MAX_MISSED_RANDOM * laterRounds,
      `failed flows: ${failures}, blind checks: ${blind}, lost guesses: ${missed}/${laterRounds}`);
    report(`${name}: a round without the card fails at least ${minCardlessCaught * 100}% of them `
      + `(${caught}/${RANDOM_GAMES}; ${checked}/${RANDOM_GAMES * ROUNDS} scoreboards checked)`,
    caught >= minCardlessCaught * RANDOM_GAMES, `caught ${caught}/${RANDOM_GAMES}`);
  }

  // ── A wrong scoreboard still fails ──
  // EXP-290: the owner's card showing the device's own name fails the flow
  const OWN_NAME_ROUND = 4;
  const ownName = play(() => STEADY_READ_MS, { ownNameRound: OWN_NAME_ROUND });
  report("a card showing the device's own name fails the flow", /score-answer-name/.test(ownName.failure || ""),
    ownName.failure || "flow passed");
  // EXP-267: a scoreboard without the card fails on that round, not passing on a later round's card
  const cardless = play(() => STEADY_READ_MS, { cardlessRound: CARDLESS_ROUND });
  const nextScoreboard = cardless.state.roundMs * CARDLESS_ROUND + cardless.state.phases.photo
    + cardless.state.phases.answering + cardless.state.phases.reveal;
  report(`a round without the card fails the flow before the next scoreboard`,
    /score-answer-card/.test(cardless.failure || "") && cardless.now < nextScoreboard,
    `${cardless.failure || "flow passed"} at ${cardless.now} ms (next scoreboard at ${nextScoreboard} ms)`);
}

try {
  const scenarios = { boot: bootScenarios, toggle: toggleScenarios, rounds: roundsScenarios };
  if (!scenarios[scenario]) throw new Error(`unknown scenario: ${scenario} (boot, toggle or rounds)`);
  scenarios[scenario](readFlow(flowFile));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
