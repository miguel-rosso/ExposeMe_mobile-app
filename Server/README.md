# ExposeMe server

Express + socket.io. Game flow and protocol: [GAME_FLOW.md](GAME_FLOW.md). Every env var the server reads, with its
default and whether it belongs in production: [.env.example](.env.example) (a test keeps the list complete).

| Command | What it does |
|---------|--------------|
| `npm run dev` | Development: ts-node with nodemon reload, port 3000 (`qa/lab/lab.sh server` also runs the sources with ts-node) |
| `npm run build` | Compiles to `dist/` with `tsconfig.build.json` (tests excluded) |
| `npm start` | Runs the sources with ts-node (what Render runs until its commands are switched, see below) |
| `npm run start:compiled` | Production: runs the compiled `dist/server.js` with plain node (run `npm run build` first) |
| `npx vitest run` | Tests |

## Deploy (Render)

Production should run the compiled JavaScript, not ts-node: ts-node keeps the TypeScript compiler in memory
(~275 MB idle RSS locally vs ~60 MB for `node dist/server.js`), which leaves little room for photo
processing on a 512 MB instance. `npm start` still runs ts-node, so a deploy keeps working until these
commands are changed on Render; nothing changes before that.

Production host: `exposeme-mobile-app-f72q.onrender.com` (`PROD_SERVER_URL` in `Client/config.ts`; invite links
point at its `/join` page too).

**Do these steps in this order**, each one deployed and checked before the next:

1. **Build** (Settings → Build & Deploy). Root directory `Server`; build command:
   ```sh
   npm ci --include=dev && npm run build
   ```
   TypeScript is a dev dependency and is needed to build; `--include=dev` installs it even once `NODE_ENV=production`
   is set (step 3). Node 20.9 or newer (`engines` in package.json, required by sharp): pin it with the `NODE_VERSION`
   env var (e.g. `22`) or a `.node-version` file. sharp installs its prebuilt Linux binaries
   (`@img/sharp-linux-x64`, in package-lock.json) during `npm ci`; nothing is compiled on the instance.
2. **Start** command:
   ```sh
   npm run start:compiled
   ```
   Deploy, and check that it comes up (`/health`, step 4) before going on.
3. **Environment** (only now, after steps 1-2 are live):
   | Variable | Value | Why |
   |----------|-------|-----|
   | `NODE_ENV` | `production` | Express' production mode. Set it last: with it, npm skips dev dependencies unless told otherwise, so a build command without `--include=dev` would leave out ts-node and TypeScript, and a server still started with `npm start` (ts-node) would no longer start. |
   | `ALLOWED_HOSTS` | `exposeme-mobile-app-f72q.onrender.com` | The only Host the socket.io endpoint answers to. A wrong value refuses every phone (check step 4 right away). Add a custom domain here if one is ever pointed at the service. |
   | `TRUST_PROXY` | `1` | Render's proxy is one hop: the client IP for rate limits and per-IP caps comes from its X-Forwarded-For. Render's own `RENDER` variable already implies 1; setting it keeps that explicit. |
   | `CONTACT_EMAIL` | the address for privacy requests | Shown on the privacy policy (`/privacy`) that the store listings link to. Unset, the page points to the store page's developer contact. |
   | `CONTROLLER_NAME` | the publisher's name | Named on the privacy policy as responsible for the data. Unset, the page points to the developer on the store page (and the server logs a warning in production). |

   `PORT` and `RENDER` are set by Render. Leave every other variable unset (the defaults are the production values),
   `APP_STORE_ID` until the iOS app is published (the invite page then links to it), and **never** set the lab-only
   `ALLOW_QA_ROUNDS`, `QA_TELEMETRY` or `QA_TELEMETRY_FILE`.
4. **Verify** after each deploy:
   - `curl https://exposeme-mobile-app-f72q.onrender.com/health` answers `{"status":"ok"}`;
   - `curl "https://exposeme-mobile-app-f72q.onrender.com/socket.io/?EIO=4&transport=polling"` answers 200 with a
     body starting `0{"sid":` (a 400 there after step 3 means `ALLOWED_HOSTS` doesn't match the host);
   - on a phone with the store build: create a room, join it from a second phone, and open an invite link in the
     browser (`/join/<code>`).

Uploads are stored in `Server/temp` (or `UPLOAD_DIR`), the same directory whether the server runs from the sources or
from `dist/`; they only live 30 minutes, so Render's ephemeral disk is enough.
