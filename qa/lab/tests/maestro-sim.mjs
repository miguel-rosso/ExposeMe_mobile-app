// Flow simulator for maestro-selectors.test.sh and maestro-timing.test.sh: runs a flow's own YAML and JS against a fake
// device with the Maestro 2.11 semantics the boot and round flows rely on (`when` conditions, `repeat` times/while,
// `retry` maxRetries <= 3, lookups that wait for the element, conditions that wait less after a command acted on the
// device, selector regex options, `below`, env variables, screen reads that take time and see the screen somewhere
// along them). The YAML is read by structure, so reordering keys or steps doesn't break it; anything it doesn't model
// (YAML, commands, selector keys, subflow files) fails with the flow's line.
// Usage: node maestro-sim.mjs <boot|toggle|rounds> FLOW CLIENT_APP_DIR -> one "<name>\t<ok|FAIL>\t<detail>" line per
// scenario. SIM_GAMES=<n> plays n seeded random games per `rounds` profile instead of 40 (rarer outcomes, e.g. 400)
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
  // With --test-output-dir (lab.sh play), Maestro 2.11 dumps the view hierarchy (one more screen read) and takes a
  // screenshot for every step that ends FAILED or WARNED (ArtifactsGenerator.onCommandFinished): a failure caught by a
  // `retry`, an optional tap that found nothing, and each step a failure goes through
  const failedStepArtifacts = () => { device.read({ id: "view-hierarchy-dump" }); step(); };
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
        if (optional) return failedStepArtifacts(); // a warning
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
      checkKeys(arg, ["visible", "notVisible", "timeout", "label"], "extendedWaitUntil");
      const met = () => (!arg.visible || isVisible(arg.visible)) && (!arg.notVisible || !isVisible(arg.notVisible));
      if (!waitFor(met, Number(value(arg.timeout)))) {
        const label = arg.label ? ` (${arg.label})` : "";
        throw new FlowFailure(`extendedWaitUntil ${describe(arg.visible || arg.notVisible)}${label}: timed out`);
      }
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
    try {
      commandsByName[name](arg, command);
    } catch (e) {
      if (e instanceof FlowFailure) failedStepArtifacts();
      throw e;
    }
  });
  try { run(commands); return { output, failure: null }; } catch (e) {
    if (e instanceof FlowFailure) return { output, failure: e.message };
    throw e;
  }
}

// ── Fake devices ──
// readMs(device, selector): how long one screen read takes (a fast phone by default). seesAt(device): where along that
// read it sees the screen, from 0 (as it starts, the default) to 1 (as it ends); elements(device, selector) is what it
// sees then
const DEFAULT_READ_MS = 500;
const device = (platform, elements, tap, readMs = () => DEFAULT_READ_MS, seesAt = () => 0) => {
  const d = { platform, now: 0, due: [], tap: (sel) => tap(d, sel) };
  d.read = (sel) => {
    const ms = readMs(d, sel);
    const untilSeen = Math.round(ms * seesAt(d));
    d.tick(untilSeen);
    const shown = elements(d, sel);
    d.tick(ms - untilSeen);
    return shown;
  };
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

// A game of `rounds` rounds as the server plays it (phase lengths and hold rules from GameEngine.ts) on a device whose
// screen reads take readMs(time) each. Records the server phase each tap on an option lands in, and by round the
// screen reads of the scoreboard checks: the card wait's that saw the scoreboard, and the card name's and
// options-under-it's, whose reads that saw no scoreboard (`blindChecks`) pass without checking anything; those that
// saw it held go to `heldReads`.
// ownerRound: the device's photo (its card says so); ownNameRounds: its card wrongly shows its own name (EXP-290);
// cardlessRounds: its scoreboard has no card; stuckPhotoRound: its photo never loads (EXP-119); slowPhotoRound: its
// photo loads SLOW_PHOTO_LOADING_MS late, which the look that ends the pass waits for.
// holds: { <round>: [{ at, ms }, ...] }, the round's owner (a bot) presses hold `at` ms into its scoreboard (or after
// its last release) and lets go `ms` later, as far as the server allows (see scoresParts): the server freezes the
// scoreboard's timer meanwhile and the app shows only the photo and the held marker (EXP-325, EXP-355).
// Rounds whose card wait ended on the held marker (`markerPasses`) and whose held marker a look for it saw (`heldSeen`).
// renderLag(round, phase): how late the device paints each phase (and each hold's start and end) after the server
// starts it (EXP-349): the screen shows the latest phase it has painted. seesAt: where along each read it sees the
// screen (see device); startAt: when the flow starts, from the game's start (when the device's wait in the lobby ends).
const PHOTO_WAIT_MS = 500; // the owner's upload (a bot's: well under a second)
const PHOTO_LOADING_MS = 1000; // the round photo's loading spinner
const SLOW_PHOTO_LOADING_MS = 7000; // a slow one (a big photo on a slow network)
const engineMs = (name) => {
  const engine = fs.readFileSync(`${clientApp}/../../Server/managers/GameEngine.ts`, "utf8");
  const m = engine.match(new RegExp(`^(?:export )?const ${name} = ([0-9_]+);`, "m"));
  if (!m) throw new Error(`GameEngine.ts: no ${name}`);
  return Number(m[1].replace(/_/g, ""));
};
// The scores phase of a round with these holds, as GameEngine.ts plays it (handleHold, releaseHold): a press is
// accepted while the round has holds left (MAX_HOLDS_PER_ROUND), and HOLD_MIN_REMAINING of both the phase and the
// hold budget; the hold is force-released when the budget runs out, and the scoreboard then resumes with what was left
// of it, at least HOLD_MIN_REMAINING. rules: those constants (holdRules). -> [[segment, ms], ...]: "scores" and
// "held" stretches
const holdRules = () => ({
  scoresMs: engineMs("SCORE_DISPLAY_TIME"), maxHolds: engineMs("MAX_HOLDS_PER_ROUND"),
  budgetMs: engineMs("HOLD_BUDGET_PER_ROUND"), minRemaining: engineMs("HOLD_MIN_REMAINING"),
});
function scoresParts(holds = [], { scoresMs, maxHolds, budgetMs, minRemaining }) {
  const parts = [];
  let left = scoresMs, budget = budgetMs;
  for (const { at, ms } of holds.slice(0, maxHolds)) {
    if (left - at < minRemaining || budget < minRemaining) break;
    const held = Math.min(ms, budget);
    parts.push(["scores", at], ["held", held]);
    left = Math.max(minRemaining, left - at);
    budget -= held;
  }
  return [...parts, ["scores", left]];
}
function game({
  rounds, readMs, seesAt, startAt = 0, username, ownerRound = 0, ownNameRounds = [], cardlessRounds = [],
  stuckPhotoRound = 0, slowPhotoRound = 0, holds = {}, renderLag = () => 0,
}) {
  const phases = [["photo", PHOTO_WAIT_MS], ["answering", engineMs("ANSWER_TIME")], ["reveal", engineMs("REVEAL_TIME")],
    ["scores", engineMs("SCORE_DISPLAY_TIME")]];
  const roundMs = phases.reduce((sum, [, ms]) => sum + ms, 0);
  const state = {
    roundMs, phases: Object.fromEntries(phases), taps: [], checks: [], blindChecks: [], heldReads: [], final: false,
    markerPasses: new Set(), heldSeen: new Set(),
  };
  // The game's timeline: one segment per phase, a held scoreboard split around its holds, then the game over. Each
  // segment shows on screen from its server start plus its paint delay
  const timeline = [];
  const rules = holdRules();
  const addSegment = (round, phase, length) => {
    const start = timeline.length ? timeline.at(-1).end : 0;
    timeline.push({ round, phase, start, end: start + length, shownFrom: start + renderLag(round, phase) });
  };
  for (let round = 1; round <= rounds; round++) {
    for (const [phase, ms] of phases) {
      for (const [name, length] of phase === "scores" ? scoresParts(holds[round], rules) : [[phase, ms]]) {
        addSegment(round, name, length);
      }
    }
  }
  addSegment(rounds, "over", Infinity);
  const at = (segment, t) => ({ round: segment.round, phase: segment.phase, into: t - segment.start });
  const serverPhaseAt = (t) => at(timeline.find((s) => t < s.end), t);
  // The latest segment painted by then (one painted after a later one is never seen)
  const screenPhaseAt = (t) => {
    const painted = timeline.findLast((s) => s.shownFrom <= t);
    return painted ? { ...at(painted, t), into: t - painted.shownFrom } : { round: 0, phase: "lobby" };
  };
  const options = [{ id: "answer-options", y: 2 }, { id: "player-option-bot1", y: 3 }, { id: "player-option-bot2", y: 3 }];
  const cardName = (round) => {
    if (ownNameRounds.includes(round)) return username;
    return round === ownerRound ? "It was your photo!" : "bot2";
  };
  const card = (round) => (cardlessRounds.includes(round) ? [] : [
    { id: "score-answer-card" }, { id: "score-answer-name", text: cardName(round) },
  ]);
  // The round photo, with its spinner while it loads; it stays under the scoreboard (GameScreen.tsx)
  const photo = (round, loadingFor) => [{ id: "photo-view" },
    ...(round === stuckPhotoRound || loadingFor < (round === slowPhotoRound ? SLOW_PHOTO_LOADING_MS : PHOTO_LOADING_MS)
      ? [{ id: "photo-loading" }] : [])];
  const screen = ({ round, phase, into }) => ({
    lobby: () => [],
    photo: () => [{ id: "game-waiting-photo" }],
    answering: () => [{ id: "round-progress", y: 1 }, ...photo(round, into), ...options],
    reveal: () => [...photo(round, Infinity), ...options],
    // the round progress bar shows during the scoreboard too (GameScreen.tsx), above it
    scores: () => [...photo(round, Infinity), { id: "round-progress", y: 0 }, { id: "score-modal" },
      { id: "score-round-title", y: 1 }, ...card(round)],
    held: () => [...photo(round, Infinity), { id: "game-held" }],
    over: () => (state.final ? [{ id: "final-score-modal" }] : [{ id: "winner-modal" }, { id: "winner-continue" }]),
  })[phase]();
  // The scoreboard checks, by selector (the card wait also ends on the held marker; the looks for the marker check
  // nothing)
  const scoreboardCheck = (sel) => {
    if (/^score-answer-card\|/.test(sel.id || "")) return "card";
    if (sel.id === "score-answer-name") return "card name";
    return sel.below?.id === "score-round-title" ? "options under it" : null;
  };
  const d = device(
    "android",
    (dev, sel) => {
      const seen = screenPhaseAt(dev.now);
      const check = scoreboardCheck(sel);
      if (seen.phase === "held" && matches(sel.id || "", "game-held")) {
        (check === "card" ? state.markerPasses : state.heldSeen).add(seen.round);
      }
      if (check && seen.phase === "scores") state.checks.push({ round: seen.round, check });
      else if (check && check !== "card") { // the card wait polls
        (seen.phase === "held" ? state.heldReads : state.blindChecks).push({ round: seen.round, check });
      }
      return screen(seen);
    },
    (dev, sel) => {
      if (matches(sel.id || "", "winner-continue")) state.final = true;
      else if (/^player-option-/.test(sel.id || "")) state.taps.push(serverPhaseAt(dev.now));
    },
    (dev) => readMs(dev.now, state),
    seesAt,
  );
  d.now = startAt;
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
// The same, with the seed scattered first (Knuth's multiplicative hash): an LCG's first draws barely differ between
// small seeds, so streams seeded n, 2n, 3n... would start alike
const scatteredRandom = (seed) => seededRandom(Math.imul(seed, 2654435761));

function roundsScenarios(flow) {
  const ROUNDS = 6;
  const USERNAME = "android-a";
  const OWNER_ROUND = 2; // the device's photo: the bots own (and may hold) the others
  const options = { skippableSubflows: ["wait-game-start.yaml"] };
  const play = (readMs, gameOptions = {}) => {
    const { d, state, env } = game({ rounds: ROUNDS, readMs, username: USERNAME, ownerRound: OWNER_ROUND, ...gameOptions });
    const result = runFlow(flow, d, { ...options, env });
    return { state, now: d.now, ...result };
  };
  const ALL_ROUNDS = Array.from({ length: ROUNDS }, (_, i) => i + 1);
  // Rounds 2 on: the first one starts from the lobby, where the device may well be late for the options
  const LATER_ROUNDS = ALL_ROUNDS.slice(1);
  // A wrong scoreboard can fail the flow on each of them but the last: the winner modal follows it
  const CATCHABLE_ROUNDS = LATER_ROUNDS.slice(0, -1);
  const missedGuesses = (state) => ALL_ROUNDS
    .filter((round) => !state.taps.some((tap) => tap.round === round && tap.phase === "answering"));
  const failedPlay = ({ state, failure }) => failure || !state.final;
  // Screen reads on the Android emulator (it136, 12-player room): 0.6-3.5 s, ~1.5 s most of the time, and now and then
  // a burst of slow ones (EXP-312, round 6 there: 3.3-3.6 s after its guess) that pushed the scoreboard checks into
  // the next answering phase
  const STEADY_READ_MS = 1500;
  const SLOW_READ_MS = 4000;
  const slowAfterGuess = (round) => (t, { roundMs, phases }) => { // from the round's reveal to its scoreboard's end
    const revealStart = (round - 1) * roundMs + phases.photo + phases.answering;
    return t >= revealStart && t < revealStart + phases.reveal + phases.scores ? SLOW_READ_MS : STEADY_READ_MS;
  };
  // Where along each screen read the device sees the screen (EXP-322): Maestro reports the screen as it was at some
  // point of its read, so every case is played with reads that see it as they start, as they end and anywhere along
  // them (a seeded random point per read, `varies`: each fixed case is then played over as many read-point patterns
  // as random games). Only reads seen as they start (`exact`) rule out a scoreboard check that reads after its
  // scoreboard closed (a blind check, which passes without checking anything) and keep every card checked on a steady
  // emulator. SIM_SEE_SEED=<n> draws other read points (every bound below must hold for any).
  const SEE_POINT_SEED = Number(process.env.SIM_SEE_SEED) || 104729;
  const SEE_POINTS = [
    { name: "seen as they start", seesAt: () => () => 0, exact: true, varies: false },
    { name: "seen as they end", seesAt: () => () => 1, exact: false, varies: false },
    { name: "seen anywhere along them", seesAt: (seed) => scatteredRandom(seed ^ SEE_POINT_SEED), exact: false, varies: true },
  ];
  const RANDOM_GAMES = Number(process.env.SIM_GAMES) || 40;
  // EXP-349: how late the device paints each phase after the server starts it, as it166's render telemetry measured
  // (the options p95 0.88 s and up to 2.2 s, the scoreboard and the rest up to 0.5 s; the flow allows a bit more,
  // optionsLagMs and phaseLagMs). Reads seen anywhere along them are also played with seeded random delays like those
  // (95 % of the options' up to the p95, `it166Lags`) and with each phase painted either on time or as late as
  // measured (`extremeLags`: the skews that most move the scoreboard away from where the options tell). Every bound
  // holds with them, but a phone that paints the options late has less time to tap them (MAX_MISSED_LAGGED)
  const RENDER_LAG_MS = { answeringP95: 880, answering: 2200, other: 500 };
  const PHASE_SALT = { photo: 1, answering: 2, reveal: 3, scores: 4, held: 5, over: 6 };
  const lagDraw = (seed, round, phase) => scatteredRandom(seed * 7907 + round * 31 + PHASE_SALT[phase])();
  const it166Lags = (seed) => (round, phase) => {
    const u = lagDraw(seed, round, phase);
    if (phase !== "answering") return Math.round(u * RENDER_LAG_MS.other);
    const { answeringP95: p95, answering: max } = RENDER_LAG_MS;
    return Math.round(u < 0.95 ? (u / 0.95) * p95 : p95 + ((u - 0.95) / 0.05) * (max - p95));
  };
  const extremeLags = (seed) => (round, phase) => (lagDraw(seed, round, phase) < 0.5 ? 0
    : RENDER_LAG_MS[phase] ?? RENDER_LAG_MS.other);
  const LAGS = [
    { name: "", renderLag: () => undefined },
    { name: " and it166's render delays", renderLag: it166Lags, lagged: true },
    { name: " and render delays on time or as late as it166's", renderLag: extremeLags, lagged: true },
  ];
  // The render delays a read-point profile and a read profile are played with
  const lagsFor = (see, profile) => (see.varies && profile.lagged ? LAGS : LAGS.slice(0, 1));
  // EXP-353: no run fails by mistake, in any profile and for any read points (SIM_SEE_SEED): the card wait fails only
  // when some look surely read a scoreboard without its card, a scoreboard it can't tell goes unchecked, and lab.sh
  // fails a run only when it checked no scoreboard and found none held, after NONE_CHECKED_MIN_WAITS card waits at
  // least (`labFails`; with fewer it warns, `tooSlowWarned`). An unchecked scoreboard it waited
  // for is a warning in lab.sh (`warned`): correct games may get one (`falseWarnings`, the most share of them).
  // Read profiles: it136's usual reads (0.6-2 s), every read it measured (0.6-3.5 s), and it166's slow Android at
  // fixed lengths (1.8-2.2 s: reads seen as they start, as they end and anywhere along them, without render delays).
  // The share of the wrong scoreboards (one per game, on each round that can catch it) that must fail the run
  // (`failed`), and fail it or warn (`flagged`), whatever the read points: on a slower phone more scoreboards go by
  // while it is still busy with the round, a missing card only fails when a look surely read the scoreboard (two reads
  // must fit in it, which slow reads seldom do), and the options painted late make that rarer (the `lagged` bounds).
  // The device's own name is checked by a 1 s look after the card wait, so it is caught less often. Each minimum is 3
  // standard deviations (of the 160 wrong scoreboards of SIM_GAMES=40) below the lowest share of the read-point (and
  // render-delay) profiles over 400 games, and each most share of warned games as many above the highest
  // (SIM_GAMES=400, rounds 2-5 of 1600, three read-point seeds; EXP-353, failed / failed or warned / warned games):
  // 0.6-2 s 1398-1430 / 1600 / 0 of 400, with render delays 1241-1411 / 1600 / 1-34; 0.6-3.5 s 50-71 / 1572-1581 /
  // 7-18, with render delays 46-58 / 1565-1589 / 27-62; fixed 1.8 s 1489-1600 / 1600 / 0-11, 2 s 1600 / 1600 / 0,
  // 2.2 s 1481-1600 / 1600 / 0-36. qa/loop's flow failed 309, 353 and 202 of 400 round 3s at fixed 1.8, 2 and 2.2 s,
  // and 1177-1223 of 1600 at 0.6-3.5 s, but those also 40 of 3600 plays by mistake. The own name: 1584-1598 and
  // 1434-1580; 866-964 and 879-906; fixed 1488-1600, 1558-1600, 1431-1600.
  // A wrong scoreboard on every round, a regression rather than a slip, must be caught in nearly every game
  // (`everyRound`): a missing card fails the flow, or lab.sh for a run that checked none (after NONE_CHECKED_MIN_WAITS
  // card waits: 0.6-3.5 s with render delays 397-399 of 400, the rest warned by lab.sh; 400 elsewhere).
  const RANDOM_PROFILES = [
    { name: "random 0.6-2 s", range: [600, 2000], lagged: true,
      bounds: { cardless: { failed: 0.75, flagged: 0.95 }, ownName: { failed: 0.9 }, falseWarnings: 0.05 },
      laggedBounds: { cardless: { failed: 0.65, flagged: 0.95 }, ownName: { failed: 0.8 }, falseWarnings: 0.25 } },
    // a missing card fails seldom here (two reads seldom fit in a scoreboard), so it is caught by the warning
    { name: "random 0.6-3.5 s", range: [600, 3500], lagged: true,
      bounds: { cardless: { failed: 0, flagged: 0.9 }, ownName: { failed: 0.4 }, falseWarnings: 0.15 },
      laggedBounds: { cardless: { failed: 0, flagged: 0.9 }, ownName: { failed: 0.4 }, falseWarnings: 0.35 } },
    { name: "fixed 1.8 s", range: [1800, 1800], lagged: false,
      bounds: { cardless: { failed: 0.85, flagged: 0.95 }, ownName: { failed: 0.85 }, falseWarnings: 0.1 } },
    { name: "fixed 2 s", range: [2000, 2000], lagged: false,
      bounds: { cardless: { failed: 0.95, flagged: 0.95 }, ownName: { failed: 0.9 }, falseWarnings: 0.05 } },
    { name: "fixed 2.2 s", range: [2200, 2200], lagged: false,
      bounds: { cardless: { failed: 0.85, flagged: 0.95 }, ownName: { failed: 0.8 }, falseWarnings: 0.25 } },
  ];
  // How the flow and lab.sh end a run: the flow failed, lab.sh fails it (no scoreboard checked, none held, EXP-353),
  // or lab.sh warns about scoreboards it waited for without seeing their card (or the held marker)
  const counts = ({ output }) => ({ waited: 0, checked: 0, held: 0, shown: 0, ...output.scoreboards });
  const labFails = (run) => {
    const { shown, waited, checked, held } = counts(run);
    return shown > 0 && waited >= NONE_CHECKED_MIN_WAITS && !checked && !held;
  };
  const unseenWaits = (run) => { const { waited, checked, held } = counts(run); return waited - checked - held; };
  const runFailed = (run) => failedPlay(run) || labFails(run);
  const warned = (run) => !runFailed(run) && unseenWaits(run) > 0;
  // lab.sh's warning for a device that showed scoreboards and checked none with too few card waits to tell
  const tooSlowWarned = (run) => {
    const { shown, waited, checked } = counts(run);
    return shown > 0 && waited < NONE_CHECKED_MIN_WAITS && !checked;
  };
  // The wrong scoreboards, the failure each must cause, whether lab.sh's warning flags it and the share of the games
  // it must be caught in when on every round (a missing card everywhere fails the flow, or lab.sh)
  const WRONG_SCOREBOARDS = {
    cardless: { what: "a round without the card", gameOption: "cardlessRounds", failure: /score-answer-card/,
      warns: true, everyRound: 0.95 },
    ownName: { what: "a card showing the device's own name", gameOption: "ownNameRounds", failure: /score-answer-name/,
      warns: false, everyRound: 0.85 },
  };
  // The round the flow's baseline catch rates were measured on (EXP-312, EXP-306)
  const BASELINE_ROUND = 3;
  // Most guesses must land: a slower phone loses some (the flow can't make a read faster), never by a false failure,
  // and one that paints the options late more, round 1's too (EXP-349: as many as qa/loop's flow, which lost up to
  // 6/40 and 21/200 of them)
  const MAX_MISSED_RANDOM = 0.05;
  const MAX_MISSED_LAGGED = 0.15;
  // Rounds whose card a screen read saw on its scoreboard
  const cardsSeen = (state) => new Set(state.checks.filter((c) => c.check === "card").map((c) => c.round));
  const randomReads = (seed, [fastest, slowest]) => {
    const random = seededRandom(seed);
    return () => Math.round(fastest + random() * (slowest - fastest));
  };

  for (const see of SEE_POINTS) {
    // One fixed case over its read-point patterns (a single one unless the points vary per read)
    const patterns = see.varies ? RANDOM_GAMES : 1;
    const playPatterns = (readMs) => Array.from({ length: patterns }, (_, i) => play(readMs, { seesAt: see.seesAt(i + 1) }));
    const ofPatterns = patterns > 1 ? ` over ${patterns} read-point patterns` : "";
    // ── Every guess in time, the scoreboard checked while it is up ──
    const cases = [
      [`steady emulator (${STEADY_READ_MS / 1000} s per screen read) ${see.name}`, () => STEADY_READ_MS],
      [`slow reads (${SLOW_READ_MS / 1000} s) through round 3's reveal and scoreboard (it136) ${see.name}`, slowAfterGuess(3)],
    ];
    for (const [name, readMs] of cases) {
      const runs = playPatterns(readMs);
      const failed = runs.filter(failedPlay);
      // A flow that failed stops guessing: its lost guesses count with its failure
      const lateGuesses = runs.filter((run) => !failedPlay(run) && missedGuesses(run.state).length);
      report(`${name}: the game ends on the results${ofPatterns}`, failed.length === 0,
        `${failed.length} failed: ${failed[0]?.failure || "no final ranking"}`);
      report(`${name}: every round's guess lands while answering${ofPatterns}`, lateGuesses.length === 0,
        `rounds without a guess in time: ${lateGuesses.map(({ state }) => missedGuesses(state).join(", ")).join("; ")}`);
      if (see.exact) {
        const [{ state }] = runs;
        report(`${name}: no scoreboard check reads after its scoreboard closed`, state.blindChecks.length === 0,
          `checks that saw no scoreboard: ${JSON.stringify(state.blindChecks)}`);
      }
    }
    if (see.exact) {
      const steady = play(() => STEADY_READ_MS, { seesAt: see.seesAt(1) });
      const unchecked = LATER_ROUNDS.filter((round) => !cardsSeen(steady.state).has(round));
      report(`steady emulator ${see.name}: the card is checked on every scoreboard after the first`, unchecked.length === 0,
        `rounds whose card went unchecked: ${unchecked.join(", ")}`);
    }

    // ── Slower phones: no false failure, few lost guesses ──
    for (const readMs of [2000, 2500]) {
      const runs = playPatterns(() => readMs);
      const wrong = runs.filter((run) => failedPlay(run) || missedGuesses(run.state).length > 1
        || (see.exact && run.state.blindChecks.length));
      const checked = runs.map(({ state }) => cardsSeen(state).size);
      report(`${readMs / 1000} s per screen read ${see.name}: the game ends on the results${ofPatterns} (`
        + `${Math.min(...checked)}-${Math.max(...checked)}/${ROUNDS} scoreboards checked), at most one guess lost`,
      wrong.length === 0, wrong.map(({ state, failure }) => `${failure || ""} rounds without a guess in time: `
        + `${missedGuesses(state).join(", ")}; blind checks: ${state.blindChecks.length}`).slice(0, 3).join(" | "));
    }
    // Seeded random reads (and render delays): the same games on every run. Each game is played again with a wrong
    // scoreboard on each round that can catch it, which must fail the flow in most games and never with another
    // failure (a scoreboard it can't tell goes unchecked), and on every round, which must be caught in nearly every
    // game
    for (const profile of RANDOM_PROFILES) {
      for (const lag of lagsFor(see, profile)) {
        let missed = 0, firstMissed = 0, blind = 0, checked = 0, falseWarned = 0;
        const failures = [];
        const caught = Object.fromEntries(Object.keys(WRONG_SCOREBOARDS)
          .map((kind) => [kind, { failed: 0, flagged: 0, baseline: 0, everyRound: 0 }]));
        for (let seed = 1; seed <= RANDOM_GAMES; seed++) {
          const playSeed = (gameOptions = {}) => play(randomReads(seed, profile.range),
            { seesAt: see.seesAt(seed), renderLag: lag.renderLag(seed), ...gameOptions });
          const run = playSeed();
          if (runFailed(run)) failures.push(`seed ${seed}: ${run.failure || (labFails(run) ? "none checked" : "no final ranking")}`);
          // a failed flow stops guessing: its lost guesses count with its failure
          const missedRounds = failedPlay(run) ? [] : missedGuesses(run.state);
          missed += missedRounds.filter((round) => round > 1).length;
          firstMissed += missedRounds.includes(1) ? 1 : 0;
          blind += run.state.blindChecks.length;
          checked += cardsSeen(run.state).size;
          falseWarned += warned(run) ? 1 : 0;
          for (const [kind, { gameOption, failure: expected, warns }] of Object.entries(WRONG_SCOREBOARDS)) {
            for (const round of CATCHABLE_ROUNDS) {
              const wrong = playSeed({ [gameOption]: [round] });
              const failed = expected.test(wrong.failure || "");
              if (failed) caught[kind].failed++;
              if (failed && round === BASELINE_ROUND) caught[kind].baseline++;
              // a run with no scoreboard checked fails in lab.sh: right too, it had a scoreboard without its card
              if (failed || (warns && (labFails(wrong) || warned(wrong)))) caught[kind].flagged++;
              if (!failed && failedPlay(wrong)) {
                failures.push(`seed ${seed}, ${kind} round ${round}: ${wrong.failure || "no final ranking"}`);
              }
            }
            const everyRound = playSeed({ [gameOption]: ALL_ROUNDS });
            if (expected.test(everyRound.failure || "") || (!failedPlay(everyRound) && labFails(everyRound))) {
              caught[kind].everyRound++;
            }
          }
        }
        const laterRounds = RANDOM_GAMES * LATER_ROUNDS.length;
        const plays = RANDOM_GAMES * (1 + Object.keys(WRONG_SCOREBOARDS).length * CATCHABLE_ROUNDS.length);
        const name = `${RANDOM_GAMES} games with ${profile.name} screen reads ${see.name}${lag.name}`;
        const bounds = lag.lagged ? profile.laggedBounds : profile.bounds;
        const maxMissed = lag.lagged ? MAX_MISSED_LAGGED : MAX_MISSED_RANDOM;
        report(`${name}: none of ${plays} plays failed by mistake${see.exact ? ", no blind check" : ` (${blind} blind checks)`}`
          + `, ${lag.lagged ? `at most ${maxMissed * 100}% of the round 1 guesses lost` : "every round 1 guess in time"} `
          + `(EXP-326), at most ${maxMissed * 100}% of the later ones (${checked}/${RANDOM_GAMES * ROUNDS} scoreboards `
          + `checked), at most ${bounds.falseWarnings * 100}% of the games warned (${falseWarned})`,
        failures.length === 0 && (!see.exact || blind === 0) && firstMissed <= (lag.lagged ? maxMissed * RANDOM_GAMES : 0)
          && missed <= maxMissed * laterRounds && falseWarned <= bounds.falseWarnings * RANDOM_GAMES,
        `failed runs: ${failures.length} ${failures.slice(0, 3).join("; ")}, blind checks: ${blind}, lost round 1 `
          + `guesses: ${firstMissed}/${RANDOM_GAMES}, lost later guesses: ${missed}/${laterRounds}, warned ${falseWarned}`);
        const wrongGames = RANDOM_GAMES * CATCHABLE_ROUNDS.length;
        for (const [kind, { what, everyRound: minEveryRound }] of Object.entries(WRONG_SCOREBOARDS)) {
          const { failed, flagged, baseline, everyRound } = caught[kind];
          const { failed: minFailed, flagged: minFlagged = 0 } = bounds[kind];
          report(`${name}: ${what} on rounds ${CATCHABLE_ROUNDS[0]}-${CATCHABLE_ROUNDS.at(-1)} fails at least `
            + `${Math.round(minFailed * 100)}% of them (${failed}/${wrongGames}; round ${BASELINE_ROUND}: ${baseline}/`
            + `${RANDOM_GAMES})${minFlagged ? `, fails or warns at least ${Math.round(minFlagged * 100)}% (${flagged})` : ""}`
            + `, and on every round at least ${minEveryRound * 100}% of the games (${everyRound})`,
          failed >= minFailed * wrongGames && flagged >= minFlagged * wrongGames
            && everyRound >= minEveryRound * RANDOM_GAMES,
          `failed ${failed}/${wrongGames}, flagged ${flagged}, every round ${everyRound}`);
        }
      }
    }
  }

  // ── Phones too slow to check (EXP-353) ──
  // With reads this slow the card wait seldom or never starts (its first read would see the next round), or misses the
  // card: the run must not fail, in the flow nor in lab.sh (whose NONE CHECKED needs NONE_CHECKED_MIN_WAITS card
  // waits), but in a small share of the games with random reads (`maxFalseFails`: every card wait of a correct game
  // missed its card: 0-3 of 400 per read-point and render-delay profile, SIM_GAMES=400 and three read-point seeds; with
  // a single card wait enough it was 59 of its 2000 games at the default seed), and a card missing on every round must
  // not pass silently either (the flow fails, or lab.sh fails or warns). Their guesses are another matter: a read that
  // slow often misses the answering phase
  const TOO_SLOW_PROFILES = [
    { name: "fixed 3.5 s", range: [3500, 3500], lagged: false, maxFalseFails: 0 },
    { name: "fixed 4 s", range: [4000, 4000], lagged: false, maxFalseFails: 0 },
    { name: "random 2.5-4 s", range: [2500, 4000], lagged: true, maxFalseFails: 0.025 },
  ];
  for (const profile of TOO_SLOW_PROFILES) {
    for (const see of SEE_POINTS) {
      for (const lag of lagsFor(see, profile)) {
        const playSeed = (seed, gameOptions = {}) => play(randomReads(seed, profile.range),
          { seesAt: see.seesAt(seed), renderLag: lag.renderLag(seed), ...gameOptions });
        const seeds = Array.from({ length: RANDOM_GAMES }, (_, i) => i + 1);
        const runs = seeds.map((seed) => playSeed(seed));
        const falseFails = runs.filter(runFailed);
        const checked = runs.reduce((sum, { state }) => sum + cardsSeen(state).size, 0);
        const name = `${RANDOM_GAMES} games with ${profile.name} screen reads ${see.name}${lag.name}`;
        const allowed = Math.floor(profile.maxFalseFails * RANDOM_GAMES);
        report(`${name}: ${allowed ? `at most ${allowed} runs fail` : "no run fails"}, in the flow or lab.sh `
          + `(${falseFails.length}; ${checked}/${RANDOM_GAMES * ROUNDS} scoreboards checked, `
          + `${runs.filter(tooSlowWarned).length} warned too slow to check)`, falseFails.length <= allowed,
        falseFails.slice(0, 3).map((run) => run.failure || (labFails(run) ? "none checked" : "no final ranking"))
          .join("; "));
        const silent = seeds.map((seed) => playSeed(seed, { cardlessRounds: ALL_ROUNDS }))
          .filter((run) => !/score-answer-card/.test(run.failure || "") && !labFails(run) && !warned(run)
            && !tooSlowWarned(run));
        report(`${name}: a card missing on every round fails or warns in every game`, silent.length === 0,
          `${silent.length} passed silently`);
      }
    }
  }

  // ── Round 1 right after the lobby (EXP-326) ──
  // it166's slow Android left the lobby about 1 s after round 1's options showed, with 1-2.2 s reads: the wait for the
  // game screen and the loop's read before its first look for the options cost it the guess
  const LATE_LOBBY_MS = 1000;
  const lateLobby = play(() => 2000, { startAt: PHOTO_WAIT_MS + LATE_LOBBY_MS });
  const firstTap = lateLobby.state.taps.find((tap) => tap.round === 1);
  report(`the lobby wait ends ${LATE_LOBBY_MS / 1000} s into round 1's options (it166), 2 s per screen read: round 1's `
    + "guess lands while answering", !lateLobby.failure && firstTap?.phase === "answering",
  `${lateLobby.failure || ""} round 1 tap: ${JSON.stringify(firstTap)}`);

  // ── A wrong scoreboard still fails ──
  // EXP-290: the owner's card showing the device's own name fails the flow
  const OWN_NAME_ROUND = 4;
  const ownName = play(() => STEADY_READ_MS, { ownNameRounds: [OWN_NAME_ROUND] });
  report("a card showing the device's own name fails the flow", /score-answer-name/.test(ownName.failure || ""),
    ownName.failure || "flow passed");
  // EXP-267: a scoreboard without the card fails on that round, not passing on a later round's card
  const CARDLESS_ROUND = 3;
  const cardless = play(() => STEADY_READ_MS, { cardlessRounds: [CARDLESS_ROUND] });
  const nextScoreboard = cardless.state.roundMs * CARDLESS_ROUND + cardless.state.phases.photo
    + cardless.state.phases.answering + cardless.state.phases.reveal;
  report(`a round without the card fails the flow before the next scoreboard`,
    /score-answer-card/.test(cardless.failure || "") && cardless.now < nextScoreboard,
    `${cardless.failure || "flow passed"} at ${cardless.now} ms (next scoreboard at ${nextScoreboard} ms)`);
  // EXP-353: how long the phone's reads take is measured on this round's single reads, so a photo that loads slowly
  // (the look that ends the pass waits for it) doesn't make the card wait skip its looks for the options from then on
  // (reads seen anywhere along them, over as many read-point patterns as random games: as often as without it)
  const SLOW_PHOTO_ROUND = 2;
  const FIXED_READ_MS = 2000;
  const MIN_CAUGHT_AFTER_SLOW_PHOTO = 0.8;
  const anywhere = SEE_POINTS.find((see) => see.varies);
  const afterSlowPhoto = Array.from({ length: RANDOM_GAMES }, (_, i) => play(() => FIXED_READ_MS,
    { seesAt: anywhere.seesAt(i + 1), slowPhotoRound: SLOW_PHOTO_ROUND, cardlessRounds: [CARDLESS_ROUND + 1] }))
    .filter(({ failure }) => /score-answer-card/.test(failure || "")).length;
  report(`a round photo that loads in ${SLOW_PHOTO_LOADING_MS / 1000} s on round ${SLOW_PHOTO_ROUND} (${FIXED_READ_MS / 1000} s per `
    + `screen read, ${anywhere.name}): round ${CARDLESS_ROUND + 1} without the card still fails at least `
    + `${MIN_CAUGHT_AFTER_SLOW_PHOTO * 100}% of ${RANDOM_GAMES} read-point patterns (${afterSlowPhoto})`,
  afterSlowPhoto >= MIN_CAUGHT_AFTER_SLOW_PHOTO * RANDOM_GAMES, `caught ${afterSlowPhoto}/${RANDOM_GAMES}`);
  // EXP-119: a round photo that never loads ends the round loop, which then fails on the game over it stopped short of
  const STUCK_PHOTO_ROUND = 3;
  const stuckPhoto = play(() => STEADY_READ_MS, { stuckPhotoRound: STUCK_PHOTO_ROUND });
  report("a round photo that never loads fails the flow on its spinner", /photo-loading/.test(stuckPhoto.failure || "")
    && stuckPhoto.now < stuckPhoto.state.roundMs * (STUCK_PHOTO_ROUND + 1),
    `${stuckPhoto.failure || "flow passed"} at ${stuckPhoto.now} ms`);

  // ── Held scoreboards (EXP-325, EXP-355) ──
  // A bot owner holding its scoreboard (bots.mjs --hold) hides the card for up to the round's hold budget, in up to
  // MAX_HOLDS_PER_ROUND holds with the scoreboard between them: the flow never fails on it, counts it as held when its
  // look for the marker sees it, and the guesses after it still land. The holds of it166 (23 s in a round, 21 s in the
  // last one), a short one, one that ends about when the scoreboard would have closed without it, and three in a row.
  // What the flow can't tell apart (Maestro reads the screen once per step), reported with the counts (EXP-350):
  // - a card wait that ended on the marker of a hold over before the look for it (`shortHoldPasses`): its scoreboard
  //   counts as checked;
  // - a hold that starts after the card wait saw the card: the name and options checks that follow may read the held
  //   screen (`heldReads`), which they pass without checking anything.
  const HOLDS = {
    3: [{ at: 1000, ms: 23000 }], 4: [{ at: 200, ms: 500 }], 5: [{ at: 1500, ms: 3500 }], 6: [{ at: 800, ms: 21000 }],
  };
  const MULTI_HOLDS = {
    3: [{ at: 300, ms: 4000 }, { at: 900, ms: 600 }, { at: 400, ms: 9000 }],
    5: [{ at: 1200, ms: 2500 }, { at: 200, ms: 25000 }],
  };
  const LONG_HOLD_ROUND = 3;
  const heldCases = [
    [`steady emulator (${STEADY_READ_MS / 1000} s per screen read)`, () => STEADY_READ_MS],
    [`slow reads (${SLOW_READ_MS / 1000} s) through round 3's reveal and scoreboard (it136)`, slowAfterGuess(3)],
  ];
  const shortHoldPasses = (state) => [...state.markerPasses].filter((round) => !state.heldSeen.has(round));
  // Every scoreboard counted as held was seen held. With reads seen as they start, every one counted as checked had
  // its card seen, but for the short holds, and no check read after its scoreboard closed; seen elsewhere, a card wait
  // may also pass on a later screen (the winner modal after the last scoreboard): a blind check too
  const heldProblems = (state, output, exact = true) => {
    const { checked, held } = output.scoreboards ?? {};
    const seen = cardsSeen(state).size;
    const short = shortHoldPasses(state).length;
    return [
      exact && checked > seen + short && `${checked} counted checked, ${seen} cards seen, ${short} short holds`,
      held !== state.heldSeen.size && `${held} counted held, ${state.heldSeen.size} seen held`,
      exact && state.blindChecks.length && `checks that saw no scoreboard: ${JSON.stringify(state.blindChecks)}`,
    ].filter(Boolean);
  };
  for (const [holdsName, holds] of [["rounds 3-6 held", HOLDS], ["rounds 3 and 5 held 3 and 2 times", MULTI_HOLDS]]) {
    for (const [name, readMs] of heldCases) {
      const { state, output, failure } = play(readMs, { holds });
      const missed = missedGuesses(state);
      const problems = heldProblems(state, output);
      report(`${name}, ${holdsName}: the game ends on the results, every guess in time`,
        !failure && state.final && missed.length === 0,
        `${failure || ""} rounds without a guess in time: ${missed.join(", ")}`);
      report(`${name}, ${holdsName}: only seen cards counted as checked, no blind check (${output.scoreboards?.held} `
        + `held, ${shortHoldPasses(state).length} short holds, ${state.heldReads.length} reads of a held screen)`,
      problems.length === 0, problems.join("; "));
    }
  }
  const steadyHeld = play(() => STEADY_READ_MS, { holds: HOLDS });
  report(`steady emulator: the ${HOLDS[LONG_HOLD_ROUND][0].ms / 1000} s hold of round ${LONG_HOLD_ROUND} is counted held`,
    steadyHeld.output.scoreboards?.held >= 1 && steadyHeld.state.heldSeen.has(LONG_HOLD_ROUND),
    `held ${steadyHeld.output.scoreboards?.held}; seen held in rounds ${[...steadyHeld.state.heldSeen].join(", ")}`);
  // A missing card on another round still fails on that round
  const cardlessHeld = play(() => STEADY_READ_MS, { holds: { 4: HOLDS[4], 5: HOLDS[5] }, cardlessRounds: [CARDLESS_ROUND] });
  report("rounds 4-5 held: a round without the card still fails the flow",
    /score-answer-card/.test(cardlessHeld.failure || ""), cardlessHeld.failure || "flow passed");

  // Seeded random reads (seen anywhere along them too, with and without render delays) and holds like the bots'
  // (bots.mjs --hold 0.5): each bot's round held with probability 0.5, pressed and let go after bots.mjs's own random
  // delays, and held again with the same probability after each release while the round has holds left (EXP-355:
  // since EXP-176 the bots hold again)
  const HOLD_PROBABILITY = 0.5;
  const MAX_HOLDS = engineMs("MAX_HOLDS_PER_ROUND");
  const { HOLD_PRESS_DELAY_MS, HOLD_LENGTH_MS } = botsConstants("HOLD_PRESS_DELAY_MS", "HOLD_LENGTH_MS");
  const randomHolds = (seed) => {
    const random = seededRandom(seed * 7919);
    const between = ([low, high]) => Math.round(low + random() * (high - low));
    const presses = () => {
      const held = [];
      while (held.length < MAX_HOLDS && random() < HOLD_PROBABILITY) {
        held.push({ at: between(HOLD_PRESS_DELAY_MS), ms: between(HOLD_LENGTH_MS) });
      }
      return held;
    };
    return Object.fromEntries(ALL_ROUNDS.filter((round) => round !== OWNER_ROUND).map((round) => [round, presses()])
      .filter(([, held]) => held.length));
  };
  for (const see of SEE_POINTS) {
    for (const profile of RANDOM_PROFILES) {
      for (const lag of lagsFor(see, profile)) {
        let failures = 0, missed = 0, holds = 0, heldRounds = 0, counted = 0, short = 0, heldReads = 0, warnings = 0;
        const problems = [], failed = [];
        for (let seed = 1; seed <= RANDOM_GAMES; seed++) {
          const gameHolds = randomHolds(seed);
          const run = play(randomReads(seed, profile.range),
            { holds: gameHolds, seesAt: see.seesAt(seed), renderLag: lag.renderLag(seed) });
          const { state, output, failure } = run;
          heldRounds += Object.keys(gameHolds).length;
          holds += Object.values(gameHolds).reduce((sum, held) => sum + held.length, 0);
          if (runFailed(run)) { // its counts and guesses stop with it
            failures++;
            failed.push(`seed ${seed} (holds ${JSON.stringify(gameHolds)}): ${failure || (labFails(run) ? "none checked"
              : "no final ranking")}`);
            continue;
          }
          warnings += warned(run) ? 1 : 0;
          missed += missedGuesses(state).filter((round) => round > 1).length;
          counted += output.scoreboards?.held ?? 0;
          short += shortHoldPasses(state).length;
          heldReads += state.heldReads.length;
          problems.push(...heldProblems(state, output, see.exact && !lag.lagged).map((p) => `seed ${seed}: ${p}`));
        }
        const laterRounds = RANDOM_GAMES * LATER_ROUNDS.length;
        const maxMissed = lag.lagged ? MAX_MISSED_LAGGED : MAX_MISSED_RANDOM;
        report(`${RANDOM_GAMES} games with ${profile.name} screen reads ${see.name}${lag.name} and bot holds (${holds} `
          + `holds in ${heldRounds} rounds: ${counted} counted held, ${short} short ones counted checked; ${heldReads} `
          + `reads of a held screen; ${warnings} games warned, as many as without holds at most): no failed run, only seen `
          + "holds counted as held"
          + `${see.exact && !lag.lagged ? ", only seen cards as checked, no blind check" : ""}, at most `
          + `${maxMissed * 100}% of the guesses after round 1 lost`,
        failures === 0 && problems.length === 0 && missed <= maxMissed * laterRounds
          && warnings <= (lag.lagged ? profile.laggedBounds : profile.bounds).falseWarnings * RANDOM_GAMES,
        `failed flows: ${failures} ${failed.slice(0, 2).join("; ")}, lost guesses: ${missed}/${laterRounds}; `
          + problems.slice(0, 3).join("; "));
      }
    }
  }
}

// lab.sh's NONE_CHECKED_MIN_WAITS: the fewest card waits, all without a card, that fail a run checking none
const NONE_CHECKED_MIN_WAITS = (() => {
  const m = fs.readFileSync(new URL("../lab.sh", import.meta.url), "utf8").match(/^NONE_CHECKED_MIN_WAITS=([0-9]+)$/m);
  if (!m) throw new Error("lab.sh: no NONE_CHECKED_MIN_WAITS");
  return Number(m[1]);
})();

// bots.mjs's own constants (`const NAME = <expression>;`, evaluated in order, HOLD_BUDGET_PER_ROUND first), so the
// simulated holds follow the bots'
function botsConstants(...names) {
  const source = fs.readFileSync(new URL("../bots.mjs", import.meta.url), "utf8");
  const values = {};
  for (const name of ["HOLD_BUDGET_PER_ROUND", ...names]) {
    const m = source.match(new RegExp(`^const ${name} = (.+);`, "m"));
    if (!m) throw new Error(`bots.mjs: no ${name}`);
    values[name] = new Function(...Object.keys(values), `"use strict"; return (${m[1]});`)(...Object.values(values));
  }
  return values;
}

try {
  const scenarios = { boot: bootScenarios, toggle: toggleScenarios, rounds: roundsScenarios };
  if (!scenarios[scenario]) throw new Error(`unknown scenario: ${scenario} (boot, toggle or rounds)`);
  scenarios[scenario](readFlow(flowFile));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
