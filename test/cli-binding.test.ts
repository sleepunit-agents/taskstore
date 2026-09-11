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
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/sqlite-store.js";

const repo = join(__dirname, "..");
// The BUILT artifact, not the TypeScript source through a loader. The bug was
// reported against `node dist/cli.js` — what the installed launcher runs — and
// this is the project's only process-level suite, so anything tsc introduces
// between src and dist has to be inside what it covers.
const cli = `node '${join(repo, "dist", "cli.js")}'`;

let dir: string;
let dbPath: string;

interface Run {
  stderr: string;
  code: number;
}

// One shell command, run with the temp store bound. `code` is the SHELL's exit
// status — which is the CLI's own only for a bare command. In a pipeline it is
// the LAST stage's, so every test below that pipes captures the CLI's status
// through statusOf() instead of reading this.
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

// The CLI's own status from inside a pipeline, written to a file by the
// subshell that runs it. POSIX sh has no pipefail, and the shell's status is
// the reader's — so a CLI that crashed mid-pipeline would otherwise be
// reported as whatever `cat` thought of it.
let statusSeq = 0;
async function statusOf(cliArgs: string, rest: string): Promise<number> {
  const stFile = join(dir, `status-${statusSeq++}`);
  await sh(`( ${cli} ${cliArgs}; echo $? > '${stFile}' ) ${rest}`);
  return Number(readFileSync(stFile, "utf8").trim());
}

beforeAll(() => {
  // Build once, so `cli` above is the current source. tsc is a couple of
  // seconds and dist/ is gitignored, so this costs nothing a developer keeps.
  execFileSync("npm", ["run", "build"], { cwd: repo, stdio: "pipe" });
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
    expect(await statusOf("export", `| cat > '${piped}'`)).toBe(0);

    expect(statSync(direct).size).toBeGreaterThan(65536); // else this proves nothing
    expect(statSync(piped).size).toBe(statSync(direct).size);
    // Byte equality across two runs is safe to assert because core.ts's
    // doExport is a pure function of state — it clones tasks and links and
    // adds no timestamp, sequence, or other per-run field. If that ever gains
    // one, compare sizes and parsed content instead of raw bytes.
    expect(readFileSync(piped).equals(readFileSync(direct))).toBe(true);
  });

  it("list emits parseable JSON down a pipe, not a 64 KiB prefix", async () => {
    const piped = join(dir, "list.json");
    // The failure this catches is silent twice over: output cut mid-token AND
    // an exit status of 0 claiming success. `cat` is the stand-in for the jq
    // the README invites, which would see a parse error rather than a prefix.
    expect(await statusOf("list", `| cat > '${piped}'`)).toBe(0);
    expect(statSync(piped).size).toBeGreaterThan(65536);
    const parsed = JSON.parse(readFileSync(piped, "utf8")) as { entries: unknown[] };
    expect(parsed.entries.length).toBe(120);
  });

  // The other half of draining on the event loop: the reader is now allowed to
  // hang up mid-write, and the queued write fails against a closed pipe. An
  // unhandled EPIPE would crash with a stack trace at exit 1 — "command
  // rejected" — for a command that succeeded, which is a worse contract
  // violation than the truncation this change removes.
  //
  // Say what this test is, precisely: it is a LOCK, not a witness. Mutation-
  // tested 2026-09-08 — it passes identically with and without cli.ts's
  // process.stdout EPIPE handler, because Node 24 already discards EPIPE on
  // stdout internally. It fails if a future runtime stops doing that and the
  // handler is missing, which is the whole reason both exist. Do not read a
  // green here as evidence that the handler works.
  it("survives a reader that stops early, at the status the command earned", async () => {
    const err = join(dir, "epipe.err");
    expect(await statusOf("export", `2> '${err}' | head -c 100 > /dev/null`)).toBe(0);
    expect(readFileSync(err, "utf8")).toBe("");

    // A reader that never reads a byte, and one on a rejected command: the
    // status still belongs to the command, not to the pipe.
    expect(await statusOf("export", `2>> '${err}' | true`)).toBe(0);
    expect(await statusOf("claim t-nonexistent", `2>> '${err}' | true`)).toBe(1);
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

// The t-574 fix: --type is now required by the binding. Before 0.3.0 the CLI
// silently defaulted to "blocks", overriding the core's E_MISSING_FIELD refusal
// with the edge that gates the ready queue. A missing flag must flow through as
// absent — undefined — so the core sees the absent field and rejects it.
// These tests guard the fix: a ?? "blocks" added back to cli.ts would make
// the first test here pass and the exit-code test above continue to pass too,
// but these would flip because the command would succeed instead of failing.
describe("--type requirement on link / unlink", () => {
  it("link without --type is rejected (exit 1, E_MISSING_FIELD)", async () => {
    const out = join(dir, "link-notype.json");
    expect((await sh(`${cli} link t-5 t-6 > '${out}'`)).code).toBe(1);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("E_MISSING_FIELD");
  });

  it("unlink without --type is rejected (exit 1, E_MISSING_FIELD)", async () => {
    // Establish a known edge first so the missing-type rejection cannot be
    // confused with an unknown-edge miss (exit 3).
    await sh(`${cli} link t-7 t-8 --type blocks > /dev/null`);
    const out = join(dir, "unlink-notype.json");
    expect((await sh(`${cli} unlink t-7 t-8 > '${out}'`)).code).toBe(1);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("E_MISSING_FIELD");
  });

  it("link with --type blocks succeeds and echoes the edge", async () => {
    const out = join(dir, "link-typed.json");
    expect((await sh(`${cli} link t-9 t-10 --type blocks > '${out}'`)).code).toBe(0);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result.ok).toBe(true);
    // Edge echo confirms the command took effect.
    expect(result.edge).toMatch(/BLOCKED BY/);
  });
});

// Edge echo direction: the echo exists to surface the reversed-pair mistake at
// the moment it is made. `link A B` means A depends on B (A is blocked by B),
// and the echo must name it that way — not "A blocks B", which is the natural
// language a confused caller writes. Both link types and the unlink branch are
// exercised here.
describe("edge echo wording and direction", () => {
  it("link --type blocks echoes 'A is now BLOCKED BY B'", async () => {
    const out = join(dir, "echo-blocks.json");
    await sh(`${cli} link t-11 t-12 --type blocks > '${out}'`);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result.edge).toBe("t-11 is now BLOCKED BY t-12");
  });

  it("link --type parent-child echoes 'A is now CHILD OF B'", async () => {
    const out = join(dir, "echo-pc.json");
    await sh(`${cli} link t-13 t-14 --type parent-child > '${out}'`);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result.edge).toBe("t-13 is now CHILD OF t-14");
  });

  it("unlink that removes a blocks edge echoes 'is no longer BLOCKED BY'", async () => {
    await sh(`${cli} link t-15 t-16 --type blocks > /dev/null`);
    const out = join(dir, "echo-unlink-blocks.json");
    await sh(`${cli} unlink t-15 t-16 --type blocks > '${out}'`);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result.edge).toBe("t-15 is no longer BLOCKED BY t-16");
  });

  it("unlink that removes a parent-child edge echoes 'is no longer CHILD OF'", async () => {
    await sh(`${cli} link t-17 t-18 --type parent-child > /dev/null`);
    const out = join(dir, "echo-unlink-pc.json");
    await sh(`${cli} unlink t-17 t-18 --type parent-child > '${out}'`);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result.edge).toBe("t-17 is no longer CHILD OF t-18");
  });

  it("missed unlink names the type and direction in the NOTHING REMOVED line", async () => {
    // No edge from t-19 to t-20 has been created, so this is a miss.
    const out = join(dir, "echo-miss.json");
    await sh(`${cli} unlink t-19 t-20 --type blocks > '${out}'`);
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result.edge).toContain("NOTHING REMOVED");
    expect(result.edge).toContain("blocks");
    expect(result.edge).toContain("t-19");
    expect(result.edge).toContain("t-20");
  });
});

// TASKSTORE_ACTOR is the binding's actor injection point. The CLI defaults to
// "art" when the var is absent; when set, it stamps the actor on every
// command that records one. The core stores it as createdBy on tasks.
describe("TASKSTORE_ACTOR attribution", () => {
  it("defaults to 'art' when TASKSTORE_ACTOR is unset", async () => {
    const createOut = join(dir, "actor-default-create.json");
    // Unset TASKSTORE_ACTOR explicitly so the test is independent of the
    // ambient environment (a CI runner might set it).
    await sh(`env -u TASKSTORE_ACTOR ${cli} create "actor default test" > '${createOut}'`);
    const created = JSON.parse(readFileSync(createOut, "utf8"));
    expect(created.ok).toBe(true);
    const id = created.id as string;

    const showOut = join(dir, "actor-default-show.json");
    await sh(`${cli} show ${id} > '${showOut}'`);
    const shown = JSON.parse(readFileSync(showOut, "utf8"));
    expect(shown.task.createdBy).toBe("art");
  });

  it("uses TASKSTORE_ACTOR when set", async () => {
    const createOut = join(dir, "actor-custom-create.json");
    await sh(`TASKSTORE_ACTOR=testbot ${cli} create "actor custom test" > '${createOut}'`);
    const created = JSON.parse(readFileSync(createOut, "utf8"));
    expect(created.ok).toBe(true);
    const id = created.id as string;

    const showOut = join(dir, "actor-custom-show.json");
    await sh(`${cli} show ${id} > '${showOut}'`);
    const shown = JSON.parse(readFileSync(showOut, "utf8"));
    expect(shown.task.createdBy).toBe("testbot");
  });
});
