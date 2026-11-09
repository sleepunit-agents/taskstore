// The felag library, from a sibling checkout (../felag, built with
// `npm ci && npm run build`) or FELAG_DIR. It is deliberately NOT an npm
// dependency: a `file:../felag` entry in package.json made installing this
// package from a git commit fail, because npm prepares a git dependency by
// running `npm install --include=dev` in a temporary clone that has no
// sibling (t-2040). Only the spec and self-verify scripts need it.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export async function loadFelag() {
  const dir = resolve(process.env.FELAG_DIR ?? join(here, "..", "..", "felag"));
  const entry = join(dir, "dist", "index.js");
  if (!existsSync(entry)) {
    throw new Error(`felag isn't built at ${dir}: clone sleepunit-agents/felag beside this checkout (or set FELAG_DIR) and run npm ci && npm run build there`);
  }
  return import(pathToFileURL(entry).href);
}
