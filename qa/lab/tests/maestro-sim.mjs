// Flow simulator for maestro-selectors.test.sh and maestro-timing.test.sh: runs a flow's own YAML and JS against a fake
// device with the Maestro 2.11 semantics the boot and round flows rely on (`when` conditions, `repeat` times/while,
// `retry` maxRetries <= 3, lookups that wait for the element, conditions that wait less after a command acted on the
// device, selector regex options, `below`, env variables, screen reads that take time and see the screen somewhere
// along them). The YAML is read by structure, so reordering keys or steps doesn't break it; anything it doesn't model
// (YAML, commands, selector keys, subflow files) fails with the flow's line.
// Usage: node maestro-sim.mjs <boot|toggle|rounds|hold> FLOW CLIENT_APP_DIR -> one "<name>\t<ok|FAIL>\t<detail>" line
// per scenario. SIM_GAMES=<n> plays n seeded random games per `rounds` and `hold` profile instead of 40 (rarer
// outcomes, e.g. 400)
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
// What a tapOn on an element costs besides the read that found it (EXP-392), whatever waitToSettleTimeoutMs says
// (Maestro 2.11, maestro-client.jar): Maestro.tap settles from the lookup's hierarchy before the touches (one read to
// compare), and hierarchyBasedTap (Android) or screenshotBasedTap (iOS) settles from scratch after them (a read, and
// one to compare). Android's driver first polls isWindowUpdating for up to 750 ms (AndroidDriver.waitForWindowToSettle),
// idle before the touches, so that wait comes first there. it238's emulators match it (each of 20 taps on an answer:
// lookup 0.6 s, 1.4 s more to the touches, 1.5 s after them; it166's took 2.9-4.9 s in all). On iOS this holds only
// on a static screen, such as the onboarding the `toggle` scenario plays: each settle there first polls for a static
// screen for up to 3 s (IOSDriver.waitUntilScreenIsStatic), which a game screen never gives (its progress bar), so
// it238's iOS guesses took 7.1-7.5 s. No scenario plays a game on iOS, so those polls are not modelled.
const TAP_SETTLE_READS = { beforeTouches: 1, afterTouches: 2 };
const WINDOW_SETTLE_MS = { android: 750, ios: 0 };
// A tap by point (`tapOn: point`, EXP-453) has no lookup and no settle wait before the touches, the window's included
// (Maestro 2.11: Orchestra.tapOnPointV2Command -> Maestro.tapOnRelative, which asks the driver for the screen size, not
// for a screen read -> hierarchyBasedTap, which with no lookup's hierarchy reads one to compare after the touches), then
// settles after them like a tap on an element. On Android that is a read and WINDOW_SETTLE_MS less than an element tap
// (its lookup's read; its settle read before the touches becomes hierarchyBasedTap's). On iOS (screenshotBasedTap) it
// takes a screenshot instead, and its settle polls for a static screen: not modelled, as for element taps
const POINT_TAP_READS_BEFORE_TOUCHES = 1;
const POLL_MS = 500;
const SELECTOR_KEYS = ["id", "text", "below", "enabled"];
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
// env: the flow's variables (`maestro test -e KEY=VALUE`); afterStep(output): called after each step
function runFlow(commands, device, { skippableSubflows = [], env = {}, afterStep = () => {} } = {}) {
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
    return { id: value(s.id), text: value(s.text), below: s.below && selector(s.below), enabled: value(s.enabled) };
  };
  const TAP_KEYS = ["optional", "waitToSettleTimeoutMs", "repeat", "delay", "retryTapIfNoChange"];
  const POINT_TAP_KEYS = ["point", "waitToSettleTimeoutMs", "repeat", "delay", "retryTapIfNoChange"];
  const describe = (s) => JSON.stringify(selector(s, TAP_KEYS));
  // `below`: some element matching it is higher on screen (smaller y); `enabled`: elements are enabled unless they say
  // otherwise
  const found = (sel, shown) => shown.filter((e) => (!sel.id || matches(sel.id, e.id)) && (!sel.text || matches(sel.text, e.text))
    && (sel.enabled === undefined || String(e.enabled ?? true) === sel.enabled)
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
  // A tap's settle wait (see TAP_SETTLE_READS)
  const settleReads = (reads) => { for (let n = 0; n < reads; n++) device.read({ id: "settle-hierarchy" }); };
  // A tap's touches on `target`: `repeat` taps `delay` ms apart (Maestro 2.11's TapRepeat)
  const touches = (arg, target) => {
    const { repeat, delay } = typeof arg === "string" ? {} : arg; // `tapOn: "<text>"` has neither
    const taps = repeat === undefined ? 1 : Number(value(repeat));
    const delayMs = delay === undefined ? 0 : Number(value(delay));
    for (let n = 0; n < taps; n++) { if (n) device.tick(delayMs); device.tap(target); }
  };
  // A tap by point (see POINT_TAP_READS_BEFORE_TOUCHES): the device's tap gets { point: "<x>,<y>" }
  const tapPoint = (arg) => {
    checkKeys(arg, POINT_TAP_KEYS, "tapOn point");
    settleReads(POINT_TAP_READS_BEFORE_TOUCHES);
    touches(arg, { point: value(arg.point) });
    settleReads(TAP_SETTLE_READS.afterTouches);
    lastInteraction = device.now;
  };
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
      if (typeof arg === "object" && "point" in arg) return tapPoint(arg);
      const optional = arg.optional === "true";
      if (!waitFor(() => isVisible(arg, TAP_KEYS), optional ? OPTIONAL_LOOKUP_MS : LOOKUP_MS)) {
        if (optional) return failedStepArtifacts(); // a warning
        throw new FlowFailure(`tapOn ${describe(arg)}: not found`);
      }
      // The settle waits around the touches
      device.tick(WINDOW_SETTLE_MS[device.platform]);
      settleReads(TAP_SETTLE_READS.beforeTouches);
      touches(arg, selector(arg, TAP_KEYS));
      settleReads(TAP_SETTLE_READS.afterTouches);
      lastInteraction = device.now;
    },
    assertVisible: (arg) => {
      if (!waitFor(() => isVisible(arg), LOOKUP_MS)) throw new FlowFailure(`assertVisible ${describe(arg)}`);
    },
    assertTrue: (arg) => { // `assertTrue: ${...}` or { condition, label }
      const { condition: cond, label } = typeof arg === "string" ? { condition: arg } : arg;
      if (!value(cond)) throw new FlowFailure(`assertTrue ${label ? value(label) : cond}`);
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
      afterStep(output);
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
  const t = { en: load(`${clientApp}/i18n/en.ts`), es: load(`${clientApp}/i18n/es.ts`) };
  const titles = { en: t.en.initialTitle, es: t.es.initialTitle };
  // The terms consent line as it reads on screen, its two links inlined (EXP-433)
  const consent = (lang) => t[lang].termsConsent.replace("{terms}", t[lang].termsOfUse).replace("{privacy}", t[lang].privacyPolicy);
  const state = { lang: startLang, home: false, taps: 0 };
  const switchLang = () => { state.lang = state.lang === "en" ? "es" : "en"; };
  const d = device(
    "ios",
    () => (state.home ? [{ id: "join-game-button" }] : [
      { id: "initial-screen" }, { id: "initial-title", text: titles[state.lang] }, { id: "language-toggle" },
      { id: "terms-consent", text: consent(state.lang) }, { id: "initial-continue-button" },
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
// saw it held go to `heldReads`. Rounds whose card a look for it saw on the scoreboard with a name that isn't the
// device's (`proven`, EXP-350: the only ones the flow may count as checked).
// ownerRound: the device's photo (its card says so); ownNameRounds: its card wrongly shows its own name (EXP-290);
// cardlessRounds: its scoreboard has no card; stuckPhotoRound: its photo never loads (EXP-119); slowPhotoRound: its
// photo loads SLOW_PHOTO_LOADING_MS late, which the look that ends the pass waits for; lateUploadRound: its owner
// uploads the photo LATE_UPLOAD_MS after the round starts instead of PHOTO_WAIT_MS (the next options come that late).
// holds: { <round>: [{ at, ms }, ...] }, the round's owner (a bot) presses hold `at` ms into its scoreboard (or after
// its last release) and lets go `ms` later, as far as the server allows (see scoresParts): the server freezes the
// scoreboard's timer meanwhile and the app shows only the photo and the held marker (EXP-325, EXP-355).
// Rounds whose card wait ended on the held marker (`markerPasses`) and whose held marker a look for it saw (`heldSeen`).
// renderLag(round, phase): how late the device paints each phase (and each hold's start and end) after the server
// starts it (EXP-349): the screen shows the latest phase it has painted. seesAt: where along each read it sees the
// screen (see device); startAt: when the flow starts, from the game's start (when the device's wait in the lobby ends).
const PHOTO_WAIT_MS = 500; // the owner's upload (a bot's: well under a second)
const LATE_UPLOAD_MS = 4000; // a phone's own upload on a slow network
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
  stuckPhotoRound = 0, slowPhotoRound = 0, lateUploadRound = 0, holds = {}, renderLag = () => 0,
}) {
  const phases = [["photo", PHOTO_WAIT_MS], ["answering", engineMs("ANSWER_TIME")], ["reveal", engineMs("REVEAL_TIME")],
    ["scores", engineMs("SCORE_DISPLAY_TIME")]];
  const roundMs = phases.reduce((sum, [, ms]) => sum + ms, 0);
  const state = {
    roundMs, phases: Object.fromEntries(phases), taps: [], checks: [], blindChecks: [], heldReads: [], final: false,
    markerPasses: new Set(), heldSeen: new Set(), proven: new Set(),
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
      const phaseMs = phase === "photo" && round === lateUploadRound ? LATE_UPLOAD_MS : ms;
      for (const [name, length] of phase === "scores" ? scoresParts(holds[round], rules) : [[phase, phaseMs]]) {
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
  // nothing): the card name's filter is the device's name, the proof's any other
  const scoreboardCheck = (sel) => {
    if (/^score-answer-card\|/.test(sel.id || "")) return "card";
    if (sel.id === "score-answer-name") return sel.text === username ? "card name" : "card proof";
    return sel.below?.id === "score-round-title" ? "options under it" : null;
  };
  // A look that proves the check sees its own element or nothing: it never passes blind
  const isLook = (check) => check === "card" || check === "card proof";
  const d = device(
    "android",
    (dev, sel) => {
      const seen = screenPhaseAt(dev.now);
      const check = scoreboardCheck(sel);
      if (seen.phase === "held" && matches(sel.id || "", "game-held")) {
        (check === "card" ? state.markerPasses : state.heldSeen).add(seen.round);
      }
      if (check && seen.phase === "scores") state.checks.push({ round: seen.round, check });
      else if (check && !isLook(check)) {
        (seen.phase === "held" ? state.heldReads : state.blindChecks).push({ round: seen.round, check });
      }
      const shown = screen(seen);
      if (check === "card proof" && seen.phase === "scores"
        && shown.some((e) => e.id === "score-answer-name" && e.text !== username)) state.proven.add(seen.round);
      return shown;
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

// hold-used-up.yaml's game (EXP-361): `rounds` rounds as the server plays them, the device owning `ownedRounds` (its
// photo: its scoreboard shows the hold button). A tap on the hold button (by its id, or by point at HOLD_TAP_POINT, its
// middle) while it is enabled is a quick hold, pressed and released QUICK_HOLD_MS apart, that reaches the server
// upLatency() ms later (in order: after the release of the previous one). The server accepts it while the round has holds left and more than HOLD_MIN_REMAINING of its
// scoreboard (GameEngine.ts), freezing the scoreboard meanwhile, and sends hold-closed once only that much is left.
// The phone paints the server events of its own scoreboards late, in the order they came: the scoreboard
// paintLag(round, "scores") ms late, its holds and their ends (the held marker; the 3rd end, holdsLeft 0, greys the
// button out: "No holds left", disabled) paintLag(round, "holds"), hold-closed (which greys it out too)
// paintLag(round, "hold-closed") but not before them, and the scoreboard's end paintLag(round, "end").
// app: "correct"; "holdsUncounted", whose button greys out only at hold-closed (a check that took that for the 3
// holds would pass by mistake); or "fourthHolds", whose greyed out button still sends presses that the server holds
// FOURTH_HOLD_MS (a release that never comes). Records each read that saw the greyed out button while looking for it
// (`usedUpReads`: the holds its round had and whether they greyed it out before hold-closed was painted), and what the
// bots heard of the device's holds (`botsHeard()`). startAt: when the flow starts, from the game's start.
const QUICK_HOLD_MS = 60;
const FOURTH_HOLD_MS = 5000;
const NO_HOLDS_LEFT = "No holds left";
function holdGame({ rounds, ownedRounds, readMs, seesAt, upLatency, paintLag = () => 0, app = "correct", startAt = 0 }) {
  const rules = holdRules();
  const untilScores = PHOTO_WAIT_MS + engineMs("ANSWER_TIME") + engineMs("REVEAL_TIME");
  const holds = Object.fromEntries(Array.from({ length: rounds }, (_, i) => [i + 1, []])); // server { from, to }
  const state = { usedUpReads: [] };
  const heldMs = (round) => holds[round].reduce((sum, { from, to }) => sum + to - from, 0);
  // A round's server times: its start, scoreboard, hold-closed and end (its holds push the last two)
  const timing = (round) => {
    const start = round === 1 ? 0 : timing(round - 1).end;
    const scores = start + untilScores;
    const end = scores + rules.scoresMs + heldMs(round);
    return { start, scores, closed: end - rules.minRemaining, end };
  };
  const press = (at) => {
    const round = ownedRounds.find((r) => timing(r).scores <= at && at < timing(r).end);
    if (!round || holds[round].some(({ to }) => at < to)) return;
    const count = holds[round].length;
    const left = timing(round).end - at;
    if ((count >= rules.maxHolds && app !== "fourthHolds") || left < rules.minRemaining) return;
    holds[round].push({ from: at, to: at + (count < rules.maxHolds ? QUICK_HOLD_MS : FOURTH_HOLD_MS) });
  };
  const options = [{ id: "photo-view" }, { id: "player-option-bot1" }, { id: "player-option-bot2" }];
  const scoreboard = [{ id: "photo-view" }, { id: "round-progress" }, { id: "score-modal" },
    { id: "score-round-title" }, { id: "score-answer-card" }, { id: "score-answer-name" }];
  // The screen at t: the round in play, its scoreboard (painted late on the device's own ones), then the game over
  const screen = (t) => {
    for (let round = 1; round <= rounds; round++) {
      const { start, scores, closed, end } = timing(round);
      const owned = ownedRounds.includes(round);
      const lag = (event) => (owned ? paintLag(round, event) : 0);
      if (t >= end + lag("end")) continue;
      if (t < start + PHOTO_WAIT_MS) return [{ id: "game-waiting-photo" }];
      if (t < scores + lag("scores")) return options;
      if (!owned) return scoreboard;
      const own = holds[round];
      const heldOn = own.some(({ from, to }) => t >= from + lag("holds") && t < to + lag("holds"));
      const byHolds = app !== "holdsUncounted" && own.length >= rules.maxHolds
        && t >= own[rules.maxHolds - 1].to + lag("holds");
      const lastHoldPainted = own.length ? own.at(-1).to + lag("holds") : -Infinity;
      const closedPainted = t >= Math.max(closed + lag("hold-closed"), lastHoldPainted);
      const button = { id: "hold-button", text: byHolds || closedPainted ? NO_HOLDS_LEFT : "Hold photo",
        enabled: !byHolds && !closedPainted, round, byHolds: byHolds && !closedPainted };
      return heldOn ? [{ id: "photo-view" }, { id: "game-held" }, button] : [...scoreboard, button];
    }
    return [{ id: "winner-modal" }];
  };
  const holdButton = (t) => screen(t).find(({ id }) => id === "hold-button");
  // What the bots hear (EXP-371, lab.sh play's check): a round of the device's photo whose 3 holds the server counted,
  // and a hold it took after those (bots.mjs reports it as a consistency error)
  state.botsHeard = () => ({
    usedUp: ownedRounds.some((round) => holds[round].length >= rules.maxHolds),
    heldAfter: ownedRounds.some((round) => holds[round].length > rules.maxHolds),
  });
  let lastArrival = -Infinity;
  const d = device(
    "android",
    (dev, sel) => {
      const shown = screen(dev.now);
      const button = shown.find(({ id }) => id === "hold-button");
      if (sel.enabled === "false" && matches(sel.id || "", "hold-button") && button && !button.enabled) {
        state.usedUpReads.push({ round: button.round, holds: holds[button.round].length, byHolds: button.byHolds });
      }
      return shown;
    },
    (dev, sel) => {
      const onButton = sel.point ? sel.point === HOLD_TAP_POINT : matches(sel.id || "", "hold-button");
      const button = onButton && holdButton(dev.now);
      if (!button || (!button.enabled && app !== "fourthHolds")) return;
      lastArrival = Math.max(dev.now + upLatency(), lastArrival + QUICK_HOLD_MS);
      press(lastArrival);
    },
    (dev) => readMs(dev.now),
    seesAt,
  );
  d.now = startAt;
  return { d, state, env: { USERNAME: "android-a", HOLD_TAP_POINT } };
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
// Seeded screen reads of a random length in [fastest, slowest] ms
const randomReads = (seed, [fastest, slowest]) => {
  const random = seededRandom(seed);
  return () => Math.round(fastest + random() * (slowest - fastest));
};

// The first `tapOn` step anywhere in the flow (inside runFlow and repeat too) whose selector id is `id`
const tapStep = (commands, id) => {
  for (const command of commands) {
    const [name, arg] = Object.entries(command)[0];
    if (name === "tapOn" && arg?.id === id) return command;
    const nested = arg?.commands && tapStep(arg.commands, id);
    if (nested) return nested;
  }
  return null;
};

// EXP-392: the guess's tapOn takes as long as it238's did on the lab's Android emulators, whose reads took 0.57-0.69 s
// (IT238_READ_MS): it touched the option 1.9-2.2 s after it started and ended 3.3-3.9 s after it (17 of its 20 taps
// on an answer, maestro.log). A model that skipped Maestro's settle waits made every slow-phone bound optimistic
const IT238_READ_MS = 650;
const IT238_TAP = { touchMs: [1850, 2200], endMs: [3250, 3900] };
function guessTapScenario(flow) {
  const OPTION = "player-option-bot1";
  const step = tapStep(flow, OPTION);
  if (!step) throw new Error(`no tapOn on ${OPTION}`);
  const touches = [];
  const d = device("android", () => [{ id: OPTION }], (dev) => touches.push(dev.now), () => IT238_READ_MS);
  runFlow([step], d);
  const within = (ms, [low, high]) => ms >= low && ms <= high;
  report(`the guess's tapOn with it238's ${IT238_READ_MS / 1000} s screen reads touches the option and ends as there `
    + `(${touches.join(", ")} and ${d.now} ms after it starts)`,
  touches.length === 1 && within(touches[0], IT238_TAP.touchMs) && within(d.now, IT238_TAP.endMs),
  `it238: touch ${IT238_TAP.touchMs.join("-")} ms, end ${IT238_TAP.endMs.join("-")} ms`);
}

function roundsScenarios(flow) {
  guessTapScenario(flow);
  const ROUNDS = 6;
  const USERNAME = "android-a";
  const OWNER_ROUND = 2; // the device's photo: the bots own (and may hold) the others
  const options = { skippableSubflows: ["wait-game-start.yaml"] };
  const play = (readMs, gameOptions = {}, afterStep = undefined) => {
    const { d, state, env } = game({ rounds: ROUNDS, readMs, username: USERNAME, ownerRound: OWNER_ROUND, ...gameOptions });
    const result = runFlow(flow, d, { ...options, env, afterStep });
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
  // Screen reads on the lab's Android emulators (EXP-392: the lookups of it238's taps on an answer, 0.57-0.69 s on 18 of
  // 20, and it166's, 0.6-1.4 s), and now and then a burst of slow ones (EXP-312, it136's 12-player room, round 6 there:
  // 3.3-3.6 s after its guess) that pushed the scoreboard checks into the next answering phase
  const STEADY_READ_MS = IT238_READ_MS;
  const SLOW_READ_MS = 4000;
  const slowAfterGuess = (round) => (t, { roundMs, phases }) => { // from the round's reveal to its scoreboard's end
    const revealStart = (round - 1) * roundMs + phases.photo + phases.answering;
    return t >= revealStart && t < revealStart + phases.reveal + phases.scores ? SLOW_READ_MS : STEADY_READ_MS;
  };
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
  // Read profiles (EXP-392): the lab's Android emulators, from the lookups of it166's and it238's taps on an answer
  // (0.5-1.4 s), it238's (fixed 0.65 s) and a slower one (fixed 1 s); reads seen as they start, as they end and
  // anywhere along them, the random ones also with render delays. Slower phones are played below (Slow phones).
  // The share of the wrong scoreboards (one per game, on each round that can catch it) that must fail the run
  // (`failed`), and fail it or warn (`flagged`), whatever the read points. A missing card only fails when a look surely
  // read the scoreboard, which the guess's tap leaves time for only on a fast phone: with reads of about 1 s the looks
  // after it wait for their element (conditionWaitMs) into the scoreboard, so a missing card is left to lab.sh's
  // warning there. The device's own name is checked by a 1 s look after the card wait. Each minimum is 3 standard
  // deviations (of the 160 wrong scoreboards of SIM_GAMES=40) below the lowest share of the read-point (and
  // render-delay) profiles over 400 games, rounded down to a multiple of 5 %, and each most share of warned games as
  // many above the highest (SIM_GAMES=400, rounds 2-5 of 1600, three read-point seeds; EXP-392, failed / failed or
  // warned / warned games): 0.5-1.4 s 93-110 / 1600 / 0 of 400, with render delays 72-106 / 1599-1600 / 0; fixed
  // 0.65 s 1600 / 1600 / 0; fixed 1 s 0 / 1600 / 0. The own name: 1597-1600, with render delays 1566-1598; 1600; 1600.
  // EXP-353's flow, played with a tap that settled for a single step instead, failed 1398-1430 of 1600 missing cards
  // with 0.6-2 s reads, and 1489-1600 with fixed 1.8-2.2 s ones.
  // A wrong scoreboard on every round, a regression rather than a slip, must be caught in nearly every game
  // (`everyRound`): a missing card fails the flow, or lab.sh for a run that checked none (after NONE_CHECKED_MIN_WAITS
  // card waits: 400 of 400 in every profile).
  const RANDOM_PROFILES = [
    { name: "random 0.5-1.4 s", range: [500, 1400], lagged: true,
      bounds: { cardless: { failed: 0, flagged: 0.95 }, ownName: { failed: 0.95 }, falseWarnings: 0.05 },
      laggedBounds: { cardless: { failed: 0, flagged: 0.95 }, ownName: { failed: 0.9 }, falseWarnings: 0.05 } },
    { name: `fixed ${IT238_READ_MS / 1000} s (it238)`, range: [IT238_READ_MS, IT238_READ_MS], lagged: false,
      bounds: { cardless: { failed: 0.95, flagged: 0.95 }, ownName: { failed: 0.95 }, falseWarnings: 0.05 } },
    // a missing card is caught by lab.sh's warning (see above)
    { name: "fixed 1 s", range: [1000, 1000], lagged: false,
      bounds: { cardless: { failed: 0, flagged: 0.95 }, ownName: { failed: 0.95 }, falseWarnings: 0.05 } },
  ];
  // How the flow and lab.sh end a run: the flow failed, lab.sh fails it (no card wait saw a card nor the held marker,
  // EXP-353), or lab.sh warns about scoreboards it waited for without seeing their card (or the held marker)
  const counts = ({ output }) => ({ waited: 0, seen: 0, checked: 0, held: 0, shown: 0, ...output.scoreboards });
  // Card waits that saw the card, not found held after it (lab.sh's `seen - held`)
  const unheldSeen = (run) => { const { seen, held } = counts(run); return seen - held; };
  const labFails = (run) => {
    const { shown, waited, held } = counts(run);
    return shown > 0 && waited >= NONE_CHECKED_MIN_WAITS && !unheldSeen(run) && !held;
  };
  const unseenWaits = (run) => { const { waited, seen } = counts(run); return waited - seen; };
  const runFailed = (run) => failedPlay(run) || labFails(run);
  const warned = (run) => !runFailed(run) && unseenWaits(run) > 0;
  // lab.sh's warning for a device that showed scoreboards and saw no card with too few card waits to tell
  const tooSlowWarned = (run) => {
    const { shown, waited } = counts(run);
    return shown > 0 && waited < NONE_CHECKED_MIN_WAITS && !unheldSeen(run);
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
  // EXP-350: the flow counted a scoreboard as checked that no read proved (or missed one it proved)
  const falselyChecked = ({ state, output }) => (output.scoreboards?.checked ?? 0) !== state.proven.size;

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
      report(`steady emulator ${see.name}: the card is seen on every scoreboard after the first (`
        + `${steady.state.proven.size} proven checked)`, unchecked.length === 0 && !falselyChecked(steady),
      `rounds whose card went unseen: ${unchecked.join(", ")}; counted checked ${steady.output.scoreboards?.checked}`);
    }

    // ── Slower phones: no false failure, few lost guesses ──
    // EXP-392: with reads of 2 s or more the guess's tap often touches after the answering phase (it settles for a read
    // and 0.75 s before the touches): those are played under Slow phones
    for (const readMs of [1200, 1500]) {
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
        let missed = 0, firstMissed = 0, blind = 0, checked = 0, proven = 0, falseWarned = 0;
        const failures = [];
        const caught = Object.fromEntries(Object.keys(WRONG_SCOREBOARDS)
          .map((kind) => [kind, { failed: 0, flagged: 0, baseline: 0, everyRound: 0 }]));
        for (let seed = 1; seed <= RANDOM_GAMES; seed++) {
          const playSeed = (gameOptions = {}) => play(randomReads(seed, profile.range),
            { seesAt: see.seesAt(seed), renderLag: lag.renderLag(seed), ...gameOptions });
          const run = playSeed();
          if (runFailed(run)) failures.push(`seed ${seed}: ${run.failure || (labFails(run) ? "none checked" : "no final ranking")}`);
          if (falselyChecked(run)) failures.push(`seed ${seed}: ${run.output.scoreboards?.checked} counted checked, `
            + `${run.state.proven.size} proven`);
          // a failed flow stops guessing: its lost guesses count with its failure
          const missedRounds = failedPlay(run) ? [] : missedGuesses(run.state);
          missed += missedRounds.filter((round) => round > 1).length;
          firstMissed += missedRounds.includes(1) ? 1 : 0;
          blind += run.state.blindChecks.length;
          checked += cardsSeen(run.state).size;
          proven += run.state.proven.size;
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
          + `(EXP-326), at most ${maxMissed * 100}% of the later ones (${checked}/${RANDOM_GAMES * ROUNDS} cards seen, `
          + `${proven} of them proven checked and no other), at most ${bounds.falseWarnings * 100}% of the games `
          + `warned (${falseWarned})`,
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

  // ── Slow phones (EXP-353, EXP-392) ──
  // it136's 12-player room (0.6-2 s most of the time, 0.6-3.5 s in all) and slower. With 0.6-2 s and fixed 1.5 s
  // reads the card wait still sees nearly every card (1950-2000 of 2000 over 400 games), though how often a single
  // missing card fails is not bounded here (its looks after the guess's tap wait for their element, conditionWaitMs,
  // into the scoreboard, as with 1 s reads above). With 2 s or more the card wait seldom or never starts (its first
  // read would see the next round), or misses the card (0.6-3.5 s: 181-222 of 2400 seen; 2 s and slower: none, every
  // game warned too slow to check). The run must not fail, in the flow nor in lab.sh (whose NONE CHECKED needs
  // NONE_CHECKED_MIN_WAITS card waits), but in a small share of the games with random reads (`maxFalseFails`: the
  // flow, or every card wait of a correct game missing its card: 0-1 of 400 per read-point and render-delay profile,
  // SIM_GAMES=400 and three read-point seeds; with a single card wait enough it was 59 of its 2000 games at the default
  // seed, EXP-353), and a card missing on every round must not pass silently either (the flow fails, or lab.sh fails
  // or warns), but in a rarer share (`maxSilent`: 0-1 of 400 with 0.6-3.5 and 2.5-4 s reads and render delays). Their
  // guesses are another matter: a read that slow often misses the answering phase
  const TOO_SLOW_PROFILES = [
    { name: "random 0.6-2 s", range: [600, 2000], lagged: true, maxFalseFails: 0 },
    { name: "random 0.6-3.5 s", range: [600, 3500], lagged: true, maxFalseFails: 0.025, maxSilent: 0.0025 },
    { name: "fixed 1.5 s", range: [1500, 1500], lagged: false, maxFalseFails: 0 },
    { name: "fixed 2 s", range: [2000, 2000], lagged: false, maxFalseFails: 0 },
    { name: "fixed 2.5 s", range: [2500, 2500], lagged: false, maxFalseFails: 0 },
    { name: "fixed 3.5 s", range: [3500, 3500], lagged: false, maxFalseFails: 0 },
    { name: "fixed 4 s", range: [4000, 4000], lagged: false, maxFalseFails: 0 },
    { name: "random 2.5-4 s", range: [2500, 4000], lagged: true, maxFalseFails: 0.025, maxSilent: 0.0025 },
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
        const allowedSilent = Math.floor((profile.maxSilent ?? 0) * RANDOM_GAMES);
        report(`${name}: a card missing on every round fails or warns in ${allowedSilent ? `all but ${allowedSilent} at `
          + "most of the games" : "every game"} (${silent.length} passed silently)`, silent.length <= allowedSilent,
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
  const FIXED_READ_MS = STEADY_READ_MS;
  const MIN_CAUGHT_AFTER_SLOW_PHOTO = 0.8;
  const anywhere = SEE_POINTS.find((see) => see.varies);
  const afterSlowPhoto = Array.from({ length: RANDOM_GAMES }, (_, i) => play(() => FIXED_READ_MS,
    { seesAt: anywhere.seesAt(i + 1), slowPhotoRound: SLOW_PHOTO_ROUND, cardlessRounds: [CARDLESS_ROUND + 1] }))
    .filter(({ failure }) => /score-answer-card/.test(failure || "")).length;
  report(`a round photo that loads in ${SLOW_PHOTO_LOADING_MS / 1000} s on round ${SLOW_PHOTO_ROUND} (${FIXED_READ_MS / 1000} s per `
    + `screen read, ${anywhere.name}): round ${CARDLESS_ROUND + 1} without the card still fails at least `
    + `${MIN_CAUGHT_AFTER_SLOW_PHOTO * 100}% of ${RANDOM_GAMES} read-point patterns (${afterSlowPhoto})`,
  afterSlowPhoto >= MIN_CAUGHT_AFTER_SLOW_PHOTO * RANDOM_GAMES, `caught ${afterSlowPhoto}/${RANDOM_GAMES}`);
  // EXP-392: a card wait that ends without seeing the card (here, on a correct app, reads longer than the scoreboard
  // from just before round 3's opens until it closes: no read sees it) still bounds where its scoreboard closed: the
  // flow's timestamps stay numbers after every step, and when the next round's options are late (its owner's upload)
  // the looks that find none tell where they showed, so that round's scoreboard is waited for and its card seen
  const BURST_ROUND = 3;
  const BURST_LEAD_MS = 1000;
  const LONGER_THAN_SCOREBOARD_MS = 6500;
  const blindThroughScoreboard = (t, { roundMs, phases }) => {
    const opens = (BURST_ROUND - 1) * roundMs + phases.photo + phases.answering + phases.reveal;
    return t >= opens - BURST_LEAD_MS && t < opens + phases.scores ? LONGER_THAN_SCOREBOARD_MS : STEADY_READ_MS;
  };
  const afterMissed = BURST_ROUND + 1;
  const ROUND_TIMES = ["closesAfter", "closesBy", "opensAfter", "opensBy", "coveredTo", "closesFrom"];
  const OPTIONS_TIMES = ["hiddenFrom", "seenAt", "lookFrom"];
  const notNumbers = new Set();
  const watchTimes = ({ round = {}, options = {} }) => {
    for (const [what, fields, values] of [["round", ROUND_TIMES, round], ["options", OPTIONS_TIMES, options]]) {
      for (const field of fields) {
        if (field in values && !Number.isFinite(Number(values[field]))) notNumbers.add(`${what}.${field}`);
      }
    }
  };
  const missed = play(blindThroughScoreboard, { lateUploadRound: afterMissed }, watchTimes);
  report(`${LONGER_THAN_SCOREBOARD_MS / 1000} s reads through round ${BURST_ROUND}'s scoreboard, its card wait over without the `
    + `card, round ${afterMissed}'s photo uploaded ${LATE_UPLOAD_MS / 1000} s in: the flow's times stay numbers and round `
    + `${afterMissed}'s card is seen`,
  !missed.failure && counts(missed).waited > counts(missed).seen && notNumbers.size === 0
    && cardsSeen(missed.state).has(afterMissed),
  `${missed.failure || ""} waited ${counts(missed).waited}, seen ${counts(missed).seen}; not numbers: `
    + `${[...notNumbers].join(", ") || "none"}; cards seen in rounds ${[...cardsSeen(missed.state)].join(", ")}`);
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
  // What the flow can't tell apart (Maestro reads the screen once per step), reported with the counts:
  // - a card wait that ended on the marker of a hold over before the look for it (`shortHoldPasses`);
  // - a hold that starts after the card wait saw the card: the name and options checks that follow may read the held
  //   screen (`heldReads`), which they pass without checking anything.
  // EXP-350: neither counts as checked. A scoreboard counts as checked only when a read proved its card (`proven`: a
  // look saw it on the scoreboard with a name that isn't the device's), whatever the read points and render delays.
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
  // Every scoreboard counted as held was seen held and every one counted as checked was proven (EXP-350). With reads
  // seen as they start, no check read after its scoreboard closed; seen elsewhere, a card wait may also pass on a
  // later screen (the winner modal after the last scoreboard): a blind check too
  const heldProblems = (state, output, exact = true) => {
    const { checked, held } = output.scoreboards ?? {};
    return [
      falselyChecked({ state, output }) && `${checked} counted checked, ${state.proven.size} proven`,
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
      report(`${name}, ${holdsName}: only proven cards counted as checked (${output.scoreboards?.checked}), no blind `
        + `check (${output.scoreboards?.held} held, ${shortHoldPasses(state).length} short holds and `
        + `${state.heldReads.length} reads of a held screen, none counted checked)`,
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
        let failures = 0, missed = 0, holds = 0, heldRounds = 0, counted = 0, checked = 0, short = 0, heldReads = 0;
        let warnings = 0;
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
          checked += output.scoreboards?.checked ?? 0;
          short += shortHoldPasses(state).length;
          heldReads += state.heldReads.length;
          problems.push(...heldProblems(state, output, see.exact && !lag.lagged).map((p) => `seed ${seed}: ${p}`));
        }
        const laterRounds = RANDOM_GAMES * LATER_ROUNDS.length;
        const maxMissed = lag.lagged ? MAX_MISSED_LAGGED : MAX_MISSED_RANDOM;
        report(`${RANDOM_GAMES} games with ${profile.name} screen reads ${see.name}${lag.name} and bot holds (${holds} `
          + `holds in ${heldRounds} rounds: ${counted} counted held, ${checked}/${RANDOM_GAMES * ROUNDS} scoreboards `
          + `checked; ${short} short holds and ${heldReads} reads of a held screen; ${warnings} games warned, as many `
          + "as without holds at most): no failed run, only seen holds counted as held, only proven cards as checked"
          + `${see.exact && !lag.lagged ? ", no blind check" : ""}, at most `
          + `${maxMissed * 100}% of the guesses after round 1 lost`,
        failures === 0 && problems.length === 0 && missed <= maxMissed * laterRounds
          && warnings <= (lag.lagged ? profile.laggedBounds : profile.bounds).falseWarnings * RANDOM_GAMES,
        `failed flows: ${failures} ${failed.slice(0, 2).join("; ")}, lost guesses: ${missed}/${laterRounds}; `
          + problems.slice(0, 3).join("; "));
      }
    }
  }
}

// ── hold-used-up.yaml (EXP-361, EXP-371) ──
// The device owns about a third of the rounds of a 10-round game (2 bots, as its header runs it), on Android (iOS's
// settle waits are not simulated). Played with reads seen as they start, as they end and anywhere along them (those
// also with the device's scoreboard events painted up to it166's 0.5 s late, or on time or that late), on fixed and
// random screen reads from a fast phone's to the slow emulator's 4 s: the flow never checks on screen an app whose
// button greys out only at hold-closed or whose 4th press holds the game, every check on the correct app saw the
// button greyed out by the 3 holds before hold-closed was painted, and the correct app fails only for want of an own scoreboard tapped on (its last assert). Each run is also
// judged like lab.sh play (EXP-371): the flow passed and the bots heard a round of the device's photo get its 3 holds
// and no hold after them. Each line states both pass rates, and the bots' check must pass (BOTS_CHECK_SHARES) the
// games whose device owns a round before the last (`countable`: a game it owns no round of, or only the last one,
// fails the flow's own assert, see its header). EXP-392: an element tap's settle waits (TAP_SETTLE_READS) made the
// presses reach the server in time only on a fast phone; EXP-453: the flow taps by point, a read and Android's window
// settle sooner (POINT_TAP_READS_BEFORE_TOUCHES), so they reach it in time with reads up to 1 s, and the flow checks
// the button on screen with reads of 0.3 s (not 0.4 s: its look then ends past closingFrom).
function holdScenarios(flow) {
  const ROUNDS = 10;
  const OWN_SHARE = 1 / 3;
  const UP_LATENCY_MS = [50, 300]; // a tap reaching the server: adb's input and the local socket
  const PAINT_LAG_MS = 500; // it166: the scoreboard and the other phases painted up to 0.5 s late
  const UNTAPPED = /A scoreboard of the device's photo got the hold presses/;
  const options = { skippableSubflows: ["open-app.yaml", "join-room.yaml", "wait-game-start.yaml"] };
  const FAST_READS = { name: "fixed 0.3 s", range: [300, 300] };
  // The share of countable games the bots' check must pass, by the slowest read: every one with reads up to it238's
  // 0.65 s (the lab's emulators), 95% with 1 s. EXP-453, SIM_GAMES=400 and two read-point seeds: 389 of 389 countable
  // games up to 1 s in every profile but 1 s with the events painted late (378-385); 0.3 s, 393 of 400 (its checks on
  // screen count a last round too); 2 s, 0-286 by profile; 3-4 s, none. The element tap of EXP-392 passed 304-389 at
  // 0.65 s and none at 1 s but those seen as they end
  const BOTS_CHECK_SHARES = [{ upToMs: 650, share: 1 }, { upToMs: 1000, share: 0.95 }];
  const botsCheckShare = (reads) => BOTS_CHECK_SHARES.find(({ upToMs }) => reads.range[1] <= upToMs)?.share ?? 0;
  const ownedRoundsOf = (seed) => {
    const own = seededRandom(seed * 104723);
    return Array.from({ length: ROUNDS }, (_, i) => i + 1).filter(() => own() < OWN_SHARE);
  };
  const countable = (seed) => ownedRoundsOf(seed).some((round) => round < ROUNDS);
  const fixedReads = (ms) => ({ name: `fixed ${ms / 1000} s`, range: [ms, ms] });
  const READS = [FAST_READS, ...[400, 500, 650, 1000, 2000, 3000, 4000].map(fixedReads),
    { name: "random 1-4 s", range: [1000, 4000] }];
  const eventSalt = (event) => [...event].reduce((hash, c) => (Math.imul(hash, 31) + c.charCodeAt(0)) >>> 0, 7);
  const lagDraw = (seed, round, event) => scatteredRandom(seed * 7907 + round * 31 + eventSalt(event))();
  const LAGS = [
    { name: "", paintLag: () => () => 0 },
    { name: ", events painted up to 0.5 s late",
      paintLag: (seed) => (round, event) => Math.round(lagDraw(seed, round, event) * PAINT_LAG_MS) },
    { name: ", events painted on time or 0.5 s late",
      paintLag: (seed) => (round, event) => (lagDraw(seed, round, event) < 0.5 ? 0 : PAINT_LAG_MS) },
  ];
  const between = (random, [low, high]) => Math.round(low + random() * (high - low));
  const play = (seed, reads, see, lag, app) => {
    const ownedRounds = ownedRoundsOf(seed);
    const latency = seededRandom(seed * 15485863);
    const { d, state, env } = holdGame({ rounds: ROUNDS, ownedRounds, readMs: randomReads(seed, reads.range),
      seesAt: see.seesAt(seed), upLatency: () => between(latency, UP_LATENCY_MS), paintLag: lag.paintLag(seed), app });
    return { state, ...runFlow(flow, d, { ...options, env }) };
  };
  // The flow checked the button on screen: it passed with a scoreboard proven (the flow's own `checked`)
  const checkedOnScreen = ({ failure, output }) => !failure && output.hold?.checked === true;
  // ...proven when the read that ended its wait saw the button greyed out by the 3 holds
  const proven = ({ state }) => state.usedUpReads.at(-1)?.byHolds === true;
  // The run as lab.sh play judges it (EXP-371): the flow passed, the bots heard a round of the device's photo get its 3
  // holds, and no hold after them
  const labPasses = (run) => {
    const { usedUp, heldAfter } = run.state.botsHeard();
    return !run.failure && usedUp && !heldAfter;
  };
  for (const reads of READS) {
    for (const see of SEE_POINTS) {
      for (const lag of see.varies ? LAGS : LAGS.slice(0, 1)) {
        let checked = 0, passed = 0, late = 0, countableGames = 0;
        const brokenPasses = { holdsUncounted: 0, fourthHolds: 0 };
        const problems = [];
        for (let seed = 1; seed <= RANDOM_GAMES; seed++) {
          const run = play(seed, reads, see, lag, "correct");
          late += run.output.hold?.late ?? 0;
          if (countable(seed)) countableGames++;
          if (checkedOnScreen(run)) checked++;
          if (labPasses(run)) passed++;
          if (checkedOnScreen(run) && !proven(run)) {
            problems.push(`seed ${seed}: checked unproven ${JSON.stringify(run.state.usedUpReads.at(-1))}`);
          }
          if (checkedOnScreen(run) && !labPasses(run)) problems.push(`seed ${seed}: checked, but the bots heard no 3 holds`);
          if (run.failure && !UNTAPPED.test(run.failure)) problems.push(`seed ${seed}: ${run.failure}`);
          for (const app of Object.keys(brokenPasses)) {
            const broken = play(seed, reads, see, lag, app);
            if (checkedOnScreen(broken)) problems.push(`seed ${seed}: checked on the ${app} app`);
            if (labPasses(broken)) brokenPasses[app]++;
          }
        }
        const share = botsCheckShare(reads);
        report(`${RANDOM_GAMES} games with ${reads.name} screen reads ${see.name}${lag.name}: checked on screen ${checked}`
          + `, each one proven, and passes ${passed} with the bots' check${share ? ` (at least ${share * 100}% of the `
          + `${countableGames} with an own round before the last)` : ""} (${late} own scoreboards reached too late on `
          + `screen); never checks on screen the apps whose holds don't grey the button out or whose 4th press holds `
          + `(the bots' check passes ${brokenPasses.holdsUncounted} and ${brokenPasses.fourthHolds} of them), never `
          + "fails but untapped",
        problems.length === 0 && passed >= share * countableGames,
        problems.slice(0, 3).join("; "));
      }
    }
  }

  // ── The paint delay in closingFrom (EXP-361) ──
  // The device's scoreboard painted LATE_SCOREBOARD_MS late and hold-closed on time: hold-closed greys the button out
  // that much sooner after the scoreboard shows than the flow would think without phaseLagMs in closingFrom. Without
  // it, the look for the greyed out button can take hold-closed's grey for the 3 holds when one of its polls sees it
  // and ends before that later bound: an app that doesn't count them is then checked. Played on a fast phone (the only
  // one that reaches its check) over a grid of read lengths, read points and flow starts, which sets where the polls
  // fall: the flow as it is never checks a broken app on screen, and the one without phaseLagMs must check some
  const LATE_SCOREBOARD_MS = 500;
  const OWN_ROUND = 2;
  const grid = (from, step, count) => Array.from({ length: count }, (_, i) => from + step * i);
  const SKEW_READS_MS = grid(100, 20, 11); // 0.1-0.3 s
  const SKEW_SEES_AT = [0, 0.5, 1];
  const SKEW_STARTS_MS = grid(0, 100, 10); // into round 1's photo and answering
  const LAG_IN_CLOSING_FROM = "output.look.hiddenFrom - output.timing.phaseLagMs + ";
  const flowText = JSON.stringify(flow);
  if (!flowText.includes(LAG_IN_CLOSING_FROM)) throw new Error("hold-used-up.yaml: closingFrom without phaseLagMs");
  const withoutLag = JSON.parse(flowText.replace(LAG_IN_CLOSING_FROM, "output.look.hiddenFrom + "));
  const BROKEN_APPS = ["holdsUncounted", "fourthHolds"];
  const skewedChecks = (steps) => SKEW_READS_MS.flatMap((readMs) => SKEW_SEES_AT.flatMap((seesAt) =>
    SKEW_STARTS_MS.flatMap((startAt) => BROKEN_APPS.filter((app) => {
      const { d, env } = holdGame({ rounds: 4, ownedRounds: [OWN_ROUND], readMs: () => readMs, seesAt: () => seesAt,
        upLatency: () => UP_LATENCY_MS[0], paintLag: (round, event) => (event === "scores" ? LATE_SCOREBOARD_MS : 0),
        app, startAt });
      return checkedOnScreen(runFlow(steps, d, { ...options, env }));
    }).map((app) => `${app} at ${readMs} ms seen at ${seesAt}, from ${startAt} ms`))));
  const flowChecks = skewedChecks(flow);
  const mutantChecks = skewedChecks(withoutLag);
  const plays = SKEW_READS_MS.length * SKEW_SEES_AT.length * SKEW_STARTS_MS.length * BROKEN_APPS.length;
  report(`the scoreboard painted ${LATE_SCOREBOARD_MS / 1000} s late and hold-closed on time, ${plays} plays on broken `
    + `apps with 0.1-0.3 s reads: the flow never checks them on screen, without phaseLagMs in closingFrom it would `
    + `(${mutantChecks.length})`,
  flowChecks.length === 0 && mutantChecks.length > 0,
  `flow checked: ${flowChecks.slice(0, 3).join(", ") || "none"}; without phaseLagMs: ${mutantChecks.slice(0, 3).join(", ")}`);
}

// A lab.sh variable's value (`NAME=value` or `NAME="value"` on a line of its own)
const labShValue = (name) => {
  const m = fs.readFileSync(new URL("../lab.sh", import.meta.url), "utf8").match(new RegExp(`^${name}="?([^"\\n]*)"?$`, "m"));
  if (!m) throw new Error(`lab.sh: no ${name}`);
  return m[1];
};
// lab.sh's NONE_CHECKED_MIN_WAITS: the fewest card waits, all without a card, that fail a run checking none
const NONE_CHECKED_MIN_WAITS = Number(labShValue("NONE_CHECKED_MIN_WAITS"));
// Where lab.sh play has the lab's phones tap the hold button (hold_tap_point's default, EXP-453; maestro-timing.test.sh
// checks it lies inside the button on their screens): the simulated device's button is there
const HOLD_TAP_POINT = labShValue("HOLD_TAP_POINT_DEFAULT");

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
  const scenarios = { boot: bootScenarios, toggle: toggleScenarios, rounds: roundsScenarios, hold: holdScenarios };
  if (!scenarios[scenario]) throw new Error(`unknown scenario: ${scenario} (boot, toggle, rounds or hold)`);
  scenarios[scenario](readFlow(flowFile));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
