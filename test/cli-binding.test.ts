// The CLI binding's own tests. Everything under test here is a property of
// the PROCESS — its stdout, its exit status — so none of it is reachable from
// the core suite, which calls runOps() in-process and never spawns anything.
//
// The case that forced this file: `taskstore export` wrote 1,768,451 bytes to
// a file and exactly 65,536 to a pipe, exit 0, on 2026-09-08. Node's stdout to
// a pipe is written through a non-blocking fd; a write that fills the buffer
// is queued, and process.exit() terminates without draining the queue.
// Redirecting to a file hid the loss completely — a file fd is written
// synchronously — which is why every interactive use had looked fine. export
// is the documented exit door; `taskstore export | gzip > backup.gz` was
// producing a 4%-complete backup and reporting success.
//
// The pipe has to be a REAL pipe, which is why these tests go through `sh -c`
// rather than child_process. A child spawned with stdio "pipe" gets a UNIX
// socketpair, whose buffer is several times a pipe's 64 KiB — an execFile
// version of this test passed against the broken binding on output that the
// shell truncated, and would flip on nothing more than a socket buffer size.
// `cli export | cat > file` is both the honest reproduction and the exact
// shape of the failing user command.

import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/sqlite-store.js";

const repo = join(__dirname, "..");
const cli = `'${join(repo, "node_modules", ".bin", "tsx")}' '${join(repo, "src", "cli.ts")}'`;

let dir: string;
let dbPath: string;

interface Run {
  stderr: string;
  code: number;
}

// One shell command, run with the temp store bound. Returns the shell's exit
// status, which is the CLI's own for a bare command.
function sh(command: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      "sh",
      ["-c", command],
      { env: { ...process.env, TASKSTORE_DB: dbPath }, maxBuffer: 64 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err && typeof (err as unknown as { code?: unknown }).code !== "number") return reject(err);
        resolve({ stderr, code: err ? (err as unknown as { code: number }).code : 0 });
      },
    );
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "taskstore-cli-"));
  dbPath = join(dir, "store.db");
  const store = new SqliteStore(dbPath);
  // Enough rows, with enough text on each, that the output cannot fit in one
  // 64 KiB pipe buffer. A store small enough to fit would let these tests pass
  // against the broken binding — so the size assertions below guard the guard.
  const filler = "x".repeat(1200);
  for (let i = 0; i < 120; i++) {
    store.run({
      op: "create",
      title: `row ${i} — ${filler}`,
      description: filler,
      actor: "test",
      at: "2026-09-08T00:00:00.000Z",
    });
  }
  store.close();
  // Sanity, measured off the database rather than off the CLI under test.
  const db = new Database(dbPath, { readonly: true });
  const bytes = (db.prepare("SELECT sum(length(record)) AS n FROM tasks").get() as { n: number }).n;
  db.close();
  expect(bytes).toBeGreaterThan(64 * 1024);
});

describe("stdout survives a pipe", () => {
  // export is the exit door. This is the assertion that a backup taken
  // through a pipe is the whole store.
  it("export writes the same bytes down a pipe as to a file", async () => {
    const direct = join(dir, "direct.jsonl");
    const piped = join(dir, "piped.jsonl");
    expect((await sh(`${cli} export > '${direct}'`)).code).toBe(0);
    expect((await sh(`${cli} export | cat > '${piped}'`)).code).toBe(0);

    expect(statSync(direct).size).toBeGreaterThan(65536); // else this proves nothing
    expect(statSync(piped).size).toBe(statSync(direct).size);
    expect(readFileSync(piped).equals(readFileSync(direct))).toBe(true);
  });

  it("list emits parseable JSON down a pipe, not a 64 KiB prefix", async () => {
    const piped = join(dir, "list.json");
    // The failure this catches is silent twice over: output cut mid-token AND
    // an exit status of 0 claiming success. `cat` is the stand-in for the jq
    // the README invites, which would see a parse error rather than a prefix.
    expect((await sh(`${cli} list | cat > '${piped}'`)).code).toBe(0);
    expect(statSync(piped).size).toBeGreaterThan(65536);
    const parsed = JSON.parse(readFileSync(piped, "utf8")) as { entries: unknown[] };
    expect(parsed.entries.length).toBe(120);
  });
});

// Exit codes are contract (README, CLAUDE.md): 0 done, 1 rejected, 2 usage,
// 3 a valid unlink that matched no edge. They were unwitnessed until now, and
// the truncation fix rewrites the very line that produces them — so these
// exist to prove the fix changes the flushing and nothing else.
describe("exit codes", () => {
  it("0 on a command that succeeds", async () => {
    expect((await sh(`${cli} show t-1 > /dev/null`)).code).toBe(0);
  });

  it("2 on an unknown verb", async () => {
    const run = await sh(`${cli} frobnicate > /dev/null`);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("usage:");
  });

  it("1 on a rejected command", async () => {
    const out = join(dir, "rejected.json");
    expect((await sh(`${cli} claim t-nonexistent > '${out}'`)).code).toBe(1);
    expect(JSON.parse(readFileSync(out, "utf8")).ok).toBe(false);
  });

  it("3 on a valid unlink that removed nothing", async () => {
    const out = join(dir, "miss.json");
    expect((await sh(`${cli} unlink t-1 t-2 --type blocks > '${out}'`)).code).toBe(3);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
    expect(result.edge).toContain("NOTHING REMOVED");
  });

  it("0 on an unlink that removed an edge", async () => {
    const out = join(dir, "hit.json");
    expect((await sh(`${cli} link t-3 t-4 --type blocks > /dev/null`)).code).toBe(0);
    expect((await sh(`${cli} unlink t-3 t-4 --type blocks > '${out}'`)).code).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).removed).toBe(true);
  });
});
