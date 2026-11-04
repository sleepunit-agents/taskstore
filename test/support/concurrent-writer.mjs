// One writer process for the concurrent-writers fixture (test/concurrency.ts).
// Runs its share of mutations against the store, one at a time, and prints
// one JSON line per write saying what it asked for and whether the store
// acknowledged it. The parent decides what was lost; this only reports.
//
//   node concurrent-writer.mjs <plan.json> <writer> <mode>
//
// mode "store": each write opens the SQLite binding afresh, runs, closes —
//   what one CLI process does, without node's startup on every write.
// mode "cli": each write is a real `taskstore` process (dist/cli.js).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "dist");
const [planPath, writerArg, mode] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const w = Number(writerArg);
const { SqliteStore } = await import(join(dist, "sqlite-store.js"));

function viaStore(cmd) {
  try {
    const s = new SqliteStore(plan.dbPath);
    try { return s.run(cmd).ok === true; } finally { s.close(); }
  } catch (e) {
    return `threw: ${e && e.message}`;
  }
}

function viaCli(args) {
  try {
    const out = execFileSync("node", [join(dist, "cli.js"), ...args], {
      env: { ...process.env, TASKSTORE_DB: plan.dbPath, TASKSTORE_ACTOR: `w${w}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out.toString()).ok === true;
  } catch (e) {
    // A non-zero exit: whatever it printed, it wasn't an acknowledgement.
    return `exit ${e && e.status}`;
  }
}

for (const op of plan.writers[w]) {
  const at = new Date().toISOString();
  let ok;
  if (mode === "cli") {
    ok = viaCli(
      op.kind === "comment" ? ["comment", op.id, op.value]
        : op.kind === "update" ? ["update", op.id, "--description", op.value]
          : ["close", op.id, "--reason", op.value],
    );
  } else {
    const actor = `w${w}`;
    ok = viaStore(
      op.kind === "comment" ? { op: "comment", id: op.id, text: op.value, actor, at }
        : op.kind === "update" ? { op: "update", id: op.id, set: { description: op.value }, actor, at }
          : { op: "close", id: op.id, reason: op.value, actor, at },
    );
  }
  process.stdout.write(JSON.stringify({ ...op, ok }) + "\n");
}
