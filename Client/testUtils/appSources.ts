import fs from "fs";
import path from "path";

const CLIENT_DIR = path.join(__dirname, "..");

/** The app's code: its routes (app/) and everything they use (src/) */
export const APP_SOURCE_DIRS = ["app", "src"].map((dir) => path.join(CLIENT_DIR, dir));

const listSources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSources(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });

/** Every .ts/.tsx file of the app's code, as absolute paths */
export const listAppSources = (): string[] => APP_SOURCE_DIRS.flatMap(listSources);

/** `file` relative to Client/, for readable failure messages */
export const clientRelative = (file: string) => path.relative(CLIENT_DIR, file);
