# ExposeMe server

Express + socket.io. Game flow and protocol: [GAME_FLOW.md](GAME_FLOW.md). Optional env vars: [.env.example](.env.example).

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

- **Root directory:** `Server`
- **Build command:** `npm ci --include=dev && npm run build` (TypeScript is a dev dependency, needed to build)
- **Start command:** `npm run start:compiled`
- **Node:** 20.9 or newer (`engines` in package.json, required by sharp). Pin it on Render with the
  `NODE_VERSION` env var (e.g. `22`) or a `.node-version` file.
- sharp installs its prebuilt Linux binaries (`@img/sharp-linux-x64`, in package-lock.json) during `npm ci`;
  nothing to compile on the instance.
- Uploads are stored in `Server/temp` (or `UPLOAD_DIR`), the same directory whether the server runs from the
  sources or from `dist/`.
