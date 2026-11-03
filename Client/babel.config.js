// Expo's default Babel setup plus stripping debug console calls from production app code (EXP-419).
// The plugin lives in this file on purpose: Metro's transform cache key only tracks the Babel config files,
// so a plugin in a separate module would need `--clear` after every edit.

// ── Strip console plugin ──

// console.warn and console.error are kept: they report real problems.
const STRIPPED_CONSOLE_METHODS = new Set(["log", "info", "debug"]);

/** Name of the console method `callee` refers to (`console.log`, `console?.log`, `console["log"]`), or null. */
function consoleMethodName(t, callee) {
  const isMember = t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee);
  if (!isMember || !t.isIdentifier(callee.object, { name: "console" })) return null;
  if (!callee.computed && t.isIdentifier(callee.property)) return callee.property.name;
  if (callee.computed && t.isStringLiteral(callee.property)) return callee.property.value;
  return null;
}

/** Removes console.log/info/debug calls, so store builds don't write game data to logcat / os_log. */
function stripConsole({ types: t }) {
  return {
    name: "strip-console",
    visitor: {
      // `console.log(x)` is a CallExpression; `console?.log(x)` and `console.log?.(x)` are OptionalCallExpressions.
      "CallExpression|OptionalCallExpression"(path) {
        const method = consoleMethodName(t, path.node.callee);
        if (!STRIPPED_CONSOLE_METHODS.has(method)) return;
        // A local variable named `console` is not the global one.
        if (path.scope.hasBinding("console")) return;
        // A bare call statement goes away; anywhere else (`cond && console.log(x)`, `() => console.log(x)`)
        // it becomes `void 0`, which is what console.log returns, so the surrounding code keeps its meaning.
        // The arguments are dropped too, so they must not carry side effects the app relies on.
        if (path.parentPath.isExpressionStatement()) path.parentPath.remove();
        else path.replaceWith(t.unaryExpression("void", t.numericLiteral(0)));
      },
    },
  };
}

// ── Config ──

function babelConfig(api) {
  // Same signal babel-preset-expo uses: Metro passes `caller.isDev`, which is false for `expo export`,
  // `expo export:embed` (release Gradle/Xcode and EAS builds). Other tools fall back to Babel's env name
  // (BABEL_ENV / NODE_ENV); jest runs as "test", so tests keep their console calls.
  const isDev = api.caller((caller) => caller?.isDev);
  const isProduction = isDev != null ? !isDev : api.env("production");
  // Dependencies keep their own logging; only the app's debug logs carry game data.
  const isNodeModule = api.caller((caller) => caller?.isNodeModule ?? false);

  return {
    presets: ["babel-preset-expo"],
    plugins: isProduction && !isNodeModule ? [stripConsole] : [],
  };
}

module.exports = babelConfig;
// Exposed for __tests__/stripConsole.test.ts.
module.exports.stripConsole = stripConsole;
