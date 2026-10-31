#!/usr/bin/env node
// The taskstore CLI — agent-first binding over the pure core. Every verb is
// one contract command; output is JSON on stdout (jq-friendly). The clock
// and actor are binding-supplied here (TASKSTORE_ACTOR, or "art"): the CLI
// is the impure shell around the pure transitions.
//
//   taskstore ready
//   taskstore create "title" [--description d] [--type t] [--priority n]
//                    [--parent id] [--spec-item-ref r] [--criterion-id c]
//                    [--legacy-ref r]
//   taskstore claim <id> | unclaim <id> | close <id> [--reason r] | reopen <id> | delete <id>
//   taskstore update <id> --title t | --description d | --priority n | --assignee a
//   taskstore comment <id> "text"
//   taskstore link <id> <dependsOn> --type blocks|parent-child
//   taskstore unlink <id> <dependsOn> --type blocks|parent-child
//     exit 0 removed, 3 valid but no such edge, 1 rejected, 2 usage
//   taskstore show <id> | list [--status s] | search <query> [--status s] | report | export
//   taskstore import <payload.json>
//   taskstore ui [page|act] --json   (loom's page; see src/loom-ui.ts)
//   taskstore api --json             (loom's piece API; see src/loom-api.ts)
//
// Store path: $TASKSTORE_DB, else ./.taskstore/store.db relative to cwd.

import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { dirname, join, resolve } from "node:path";
import { SqliteStore } from "./sqlite-store.js";
import type { Command, Link, Task } from "./core.js";
import { checkAct, manifest, page, type ReadyEntry, type UiView } from "./loom-ui.js";
import { answer, type ApiRequest } from "./loom-api.js";
import { spawn, spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const verb = argv.shift();

const positional: string[] = [];
// Object.create(null): a plain {} has a prototype, so `--__proto__ x` would
// invoke the inherited __proto__ setter instead of creating an own key —
// the value is silently swallowed and Object.keys(flags) never sees it,
// which is exactly the silent-drop checkKnownFlags() below exists to close.
const flags: Record<string, string> = Object.create(null);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    flags[a.slice(2)] = argv[++i] ?? "";
  } else positional.push(a);
}

// A consumer is allowed to stop reading early — `| head`, `| jq ... | head`,
// a pager quit on the first screen. Once stdout drains on the event loop
// rather than at exit (see the foot of this file), the queued write outlives
// the closed pipe and fails, and an unhandled 'error' on process.stdout would
// crash with a stack trace and exit 1 — the status this CLI defines as
// "command rejected", for a command that did nothing wrong.
//
// Node 24 does not currently do that: measured 2026-09-08, `export | head -1`,
// `list | head -c 100` and `export | true` each left the CLI's own status 0
// with empty stderr, because Node's internal stdout handling already discards
// EPIPE. This handler is here so that behavior is the contract's rather than
// the runtime's, on every version. A reader hanging up is not an error the
// caller asked about, so keep whatever status the command earned.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(process.exitCode === undefined ? 0 : Number(process.exitCode));
  throw err;
});

const actor = process.env.TASKSTORE_ACTOR ?? "art";
const at = new Date().toISOString();
const dbPath = resolve(process.env.TASKSTORE_DB ?? join(".taskstore", "store.db"));

interface VerbEntry {
  allowedFlags: Set<string>;
  build: (positional: string[], flags: Record<string, string>) => Command;
}

// One table drives both the flag allowlist and the command dispatch — the
// flags a verb accepts live right next to the build() that reads them, so
// a verb added here is automatically known to both checks. Before this, the
// allowlist (KNOWN_FLAGS) and the dispatch (buildCommand's switch) were two
// independently-maintained structures with nothing pinning one's key set to
// the other's case set: a verb added to the switch but forgotten in
// KNOWN_FLAGS would silently fall through to checkKnownFlags()'s "unknown
// verb, not my problem" early return and ship with NO flag validation at
// all — the exact pre-t-893 silent-drop bug class, just moved one level up.
// `satisfies`, not an annotation: an annotation widens VERBS' type to
// Record<string, VerbEntry>, which erases its own key set and defeats the
// "one table pins both" property this comment claims — satisfies checks
// the same shape without erasing it.
const VERBS = {
  create: {
    allowedFlags: new Set(["description", "type", "priority", "parent", "spec-item-ref", "criterion-id", "legacy-ref"]),
    build: (positional, flags) => {
      const c: Command = { op: "create", title: positional[0], actor, at };
      if (flags.description !== undefined) c.description = flags.description;
      if (flags.type !== undefined) c.type = flags.type;
      if (flags.priority !== undefined) c.priority = Number(flags.priority);
      if (flags.parent !== undefined) c.parent = flags.parent;
      if (flags["spec-item-ref"] !== undefined) c.specItemRef = flags["spec-item-ref"];
      if (flags["criterion-id"] !== undefined) c.criterionId = flags["criterion-id"];
      if (flags["legacy-ref"] !== undefined) c.legacyRef = flags["legacy-ref"];
      return c;
    },
  },
  claim: {
    allowedFlags: new Set(),
    build: (positional) => ({ op: "claim", id: positional[0], actor, at }),
  },
  unclaim: {
    allowedFlags: new Set(),
    build: (positional) => ({ op: "unclaim", id: positional[0], actor, at }),
  },
  close: {
    allowedFlags: new Set(["reason"]),
    build: (positional, flags) => {
      const c: Command = { op: "close", id: positional[0], actor, at };
      if (flags.reason !== undefined) c.reason = flags.reason;
      return c;
    },
  },
  reopen: {
    allowedFlags: new Set(),
    build: (positional) => ({ op: "reopen", id: positional[0], actor, at }),
  },
  delete: {
    allowedFlags: new Set(),
    build: (positional) => ({ op: "delete", id: positional[0], actor, at }),
  },
  update: {
    allowedFlags: new Set(["title", "description", "assignee", "priority"]),
    build: (positional, flags) => {
      const set: Record<string, unknown> = {};
      for (const k of ["title", "description", "assignee"]) if (flags[k] !== undefined) set[k] = flags[k];
      if (flags.priority !== undefined) set.priority = Number(flags.priority);
      return { op: "update", id: positional[0], set, actor, at };
    },
  },
  comment: {
    allowedFlags: new Set(),
    build: (positional) => ({ op: "comment", id: positional[0], text: positional[1], actor, at }),
  },
  // --type is passed through ABSENT when absent. It used to default to
  // "blocks", which meant a missing flag silently built the edge that gates
  // the ready queue; the core has always required the field (E_MISSING_FIELD)
  // and the binding was overriding that refusal with the destructive choice.
  link: {
    allowedFlags: new Set(["type"]),
    build: (positional, flags) => ({ op: "link", id: positional[0], dependsOn: positional[1], type: flags.type, actor, at }),
  },
  unlink: {
    allowedFlags: new Set(["type"]),
    build: (positional, flags) => ({ op: "unlink", id: positional[0], dependsOn: positional[1], type: flags.type, actor, at }),
  },
  show: {
    allowedFlags: new Set(),
    build: (positional) => ({ op: "show", id: positional[0] }),
  },
  list: {
    allowedFlags: new Set(["status"]),
    build: (_positional, flags) => {
      const c: Command = { op: "list" };
      if (flags.status !== undefined) c.status = flags.status;
      return c;
    },
  },
  search: {
    allowedFlags: new Set(["status"]),
    build: (positional, flags) => {
      const c: Command = { op: "search", q: positional[0] };
      if (flags.status !== undefined) c.status = flags.status;
      return c;
    },
  },
  ready: {
    allowedFlags: new Set(),
    build: () => ({ op: "ready" }),
  },
  report: {
    allowedFlags: new Set(),
    build: () => ({ op: "report" }),
  },
  export: {
    allowedFlags: new Set(),
    build: () => ({ op: "export" }),
  },
  import: {
    allowedFlags: new Set(),
    build: (positional) => {
      const payload = JSON.parse(readFileSync(positional[0], "utf8")) as Record<string, unknown>;
      return { op: "import", tasks: payload.tasks, links: payload.links, actor, at };
    },
  },
} satisfies Record<string, VerbEntry>;

// Object.hasOwn, not a bare VERBS[verb]: a caller-controlled verb string can
// name an inherited Object.prototype member — a plain function (toString,
// valueOf, hasOwnProperty), the special-formed constructor, or the __proto__
// accessor, which resolves to Object.prototype itself. Without this check
// `taskstore toString --x y` binds `entry` to one of those instead of
// `undefined`; `entry.allowedFlags.has(...)` (checkKnownFlags, only reached
// when a flag was passed) or `entry.build(...)` (buildCommand, otherwise)
// then throws an uncaught TypeError, and the command exits 1 with a stack
// trace instead of the clean "unknown verb" / exit 2 both callers below need.
function verbEntry(): VerbEntry | undefined {
  return verb !== undefined && Object.hasOwn(VERBS, verb) ? VERBS[verb as keyof typeof VERBS] : undefined;
}

function checkKnownFlags(): void {
  const entry = verbEntry();
  if (!entry) return; // unknown verb: buildCommand's own `if (!entry)` branch owns this error
  const unknown = Object.keys(flags).filter((k) => !entry.allowedFlags.has(k));
  if (unknown.length > 0) {
    const plural = unknown.length > 1 ? "s" : "";
    console.error(`unknown flag${plural} for '${verb}': ${unknown.map((k) => `--${k}`).join(", ")}`);
    process.exit(2);
  }
}

function buildCommand(): Command {
  const entry = verbEntry();
  if (!entry) {
    console.error(`usage: taskstore <${Object.keys(VERBS).join("|")}> ...`);
    // This exit() stays, unlike the one at the end of the file. It is the
    // only way out of a branch that owes the caller a Command and has none
    // — setting process.exitCode here would fall through and run the whole
    // command path on `undefined`. It is also safe on the grounds the other
    // one was not: nothing has been written to stdout yet, and the single
    // short line above fits any pipe buffer, so there is no queued write to
    // discard.
    process.exit(2);
  }
  return entry.build(positional, flags);
}

// Synchronous, all of it: an answer can run to a few hundred KB, past a
// pipe's 64 KiB buffer, and stdout may be non-blocking (see the foot of this
// file), so keep going after a partial write and wait out EAGAIN.
function writeAll(text: string): void {
  const buf = Buffer.from(text);
  for (let off = 0; off < buf.length;) {
    try {
      off += writeSync(1, buf, off);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

// `api`: taskstore over loom's piece API (src/loom-api.ts). The command runs
// as this same CLI in a child process, with the caller's actor, against the
// store that already exists (like `ui`, never a new one in loom-http's cwd).
if (verb === "api") {
  if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
    console.error(`taskstore: no store at ${dbPath} (set TASKSTORE_DB)`);
    process.exit(1);
  }
  let request: ApiRequest | null = null;
  try {
    request = JSON.parse(readFileSync(0, "utf8")) as ApiRequest;
  } catch {
    request = null;
  }
  const out = answer(request, process.env, (args, who) => {
    const r = spawnSync(process.execPath, [process.argv[1], ...args], {
      env: { ...process.env, TASKSTORE_DB: dbPath, TASKSTORE_ACTOR: who },
      input: "", encoding: "utf8", timeout: 12_000, maxBuffer: 32 * 1024 * 1024,
    });
    return { exit: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.error ? String(r.error) : (r.stderr ?? "") };
  });
  writeAll(JSON.stringify(out) + "\n");
  process.exit(0);
}

// `bundle export|import`: the tasks piece's part of loom's household bundle
// (loom docs/extensions.md, "The bundle: a piece's part"). The whole store, a
// consistent copy (VACUUM INTO), encrypted by the piece to the owner's
// recipients (LOOM_EXPORT_RECIPIENTS); on import, decrypted with the owner's
// key (LOOM_IMPORT_IDENTITY) into TASKSTORE_DB, never over a store that's
// there unless --force. The plaintext only ever sits in a private temp dir.
if (verb === "bundle") process.exit(bundle(positional[0] ?? "", "force" in flags));

function bundle(sub: string, force: boolean): number {
  const age = process.env.LOOM_AGE || "age";
  const fail = (msg: string): number => { console.error(`taskstore: ${msg}`); return 1; };
  if (sub !== "export" && sub !== "import") { console.error("usage: taskstore bundle export|import [--force]"); return 2; }
  // The plaintext copy lives only here, and goes on every way out (exit codes are returned, never process.exit inside).
  const tmp = mkdtempSync(join(tmpdir(), "taskstore-bundle-"));
  try {
    const plain = join(tmp, "store.db");
    if (sub === "export") {
      const recipients = (process.env.LOOM_EXPORT_RECIPIENTS ?? "").split(",").map((r) => r.trim()).filter(Boolean);
      if (!recipients.length) return fail("LOOM_EXPORT_RECIPIENTS is empty: a part is never written out in the clear");
      if (!existsSync(dbPath) || !statSync(dbPath).isFile()) return fail(`no store at ${dbPath} (set TASKSTORE_DB)`);
      const src = new Database(dbPath, { readonly: true });
      try { src.prepare("VACUUM INTO ?").run(plain); } finally { src.close(); }
      const r = spawnSync(age, ["-e", "-a", ...recipients.flatMap((x) => ["-r", x]), plain], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
      if (r.status !== 0) return fail(`age: ${(r.error?.message ?? r.stderr ?? "").trim().split("\n").pop()}`);
      writeAll(r.stdout);
      return 0;
    }
    const identity = process.env.LOOM_IMPORT_IDENTITY;
    if (!identity) return fail("LOOM_IMPORT_IDENTITY names the owner's key file");
    if (existsSync(dbPath) && !force) return fail(`${dbPath} is already a store; restore onto a fresh one, or pass --force. Nothing was written.`);
    const r = spawnSync(age, ["-d", "-i", identity, "-o", plain], { input: readFileSync(0), maxBuffer: 1024 * 1024 });
    const bytes = r.status === 0 && existsSync(plain) ? readFileSync(plain) : Buffer.alloc(0);
    if (bytes.subarray(0, 16).toString("latin1") !== "SQLite format 3\0") {
      return fail("the part doesn't decrypt with LOOM_IMPORT_IDENTITY, or isn't a store. Nothing was written.");
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    // Private from its first byte, and never through something already at that name ("wx").
    const dest = `${dbPath}.${process.pid}.tmp`;
    const fd = openSync(dest, "wx", 0o600);
    try { writeSync(fd, bytes); } finally { closeSync(fd); }
    for (const side of ["-wal", "-shm"]) rmSync(dbPath + side, { force: true });
    renameSync(dest, dbPath);
    console.log(`restored the store to ${dbPath}`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// `ui`: taskstore on loom's page (src/loom-ui.ts, loom docs/extensions.md
// "The page", contract v2), when it runs as loom's tasks piece:
//   ui [--json]        the manifest (tab, Home tile, the owner's asks)
//   ui page --json     stdin {path, query} -> one page
//   ui act --json      stdin {action, path, fields} -> {ok, message, page?}
// Only a store that already exists: loom-http calls this from its own working
// directory, and opening the default relative path there would create an
// empty store. Pages are reads; the one action writes through the core's own
// comment op, as the owner (TASKSTORE_OWNER; unset, there are no asks and a
// comment from the page is posted as "loom-page").
if (verb === "ui") {
  const sub = positional[0] ?? "";
  if (!["", "page", "act"].includes(sub)) {
    console.error("usage: taskstore ui [page|act] --json");
    process.exit(2);
  }
  if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
    console.error(`taskstore: no store at ${dbPath} (set TASKSTORE_DB)`);
    process.exit(1);
  }
  const owner = process.env.TASKSTORE_OWNER?.trim() || "";
  // Malformed stdin is a request loom can't have meant: null routes to Not
  // found (page) or ok:false (act), never a crash.
  const request = (): unknown => {
    try {
      return JSON.parse(readFileSync(0, "utf8"));
    } catch {
      return null;
    }
  };
  const uiStore = new SqliteStore(dbPath);
  const read = (): UiView => {
    const all = uiStore.run({ op: "export" }) as { tasks?: Task[]; links?: Link[] };
    const ready = uiStore.run({ op: "ready" }) as { entries?: ReadyEntry[] };
    return {
      tasks: all.tasks ?? [], links: all.links ?? [], ready: ready.entries ?? [],
      owner, now: new Date(), timeZone: process.env.TZ || undefined,
    };
  };
  let out: unknown;
  if (sub === "") out = manifest(read());
  else if (sub === "page") out = page(read(), request());
  else {
    const req = request();
    const check = checkAct(read(), req);
    if (!check.ok) out = check;
    else if (check.action === "create") {
      const at = new Date().toISOString();
      const r = uiStore.run({ op: "create", title: check.title, priority: check.priority, ...(check.description ? { description: check.description } : {}), actor: owner || "loom-page", at });
      const id = r.ok === true ? String((r as { id?: unknown }).id ?? "") : "";
      if (id && check.mine) uiStore.run({ op: "update", id, set: { assignee: owner }, actor: owner, at } as Command);
      out = id
        ? { ok: true, message: `${id} is filed.`, page: `task/${id}` }
        : { ok: false, message: `It wasn't filed (${(r.errors as string[] | undefined)?.join(", ") ?? "rejected"}).` };
    } else if (check.action === "comment") {
      const at = new Date().toISOString();
      const r = uiStore.run({ op: "comment", id: check.id, text: check.text, actor: owner || "loom-page", at });
      let message = "Comment added.";
      if (r.ok === true && owner) {
        // The owner answered: the task goes back to the agents (it leaves Your call), and one is woken to act on it.
        const agent = (process.env.TASKSTORE_AGENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean)[0];
        const task = (uiStore.run({ op: "show", id: check.id }) as { task?: { assignee?: string } }).task;
        if (agent && task?.assignee === owner) uiStore.run({ op: "update", id: check.id, set: { assignee: agent }, actor: owner, at } as Command);
        if (onOwnerComment(check.id)) message = `Comment added. ${agent ? agent[0].toUpperCase() + agent.slice(1) : "An agent"} picks it up.`;
      }
      out = r.ok === true
        ? { ok: true, message, page: `task/${check.id}` }
        : { ok: false, message: `The comment wasn't added (${(r.errors as string[] | undefined)?.join(", ") ?? "rejected"}).` };
    } else {
      // Mark done, and its Undo (loom's ActResult.undo): reopen.
      const r = uiStore.run({ op: check.action, id: check.id, actor: owner || "loom-page", at: new Date().toISOString() } as Command);
      out = r.ok !== true
        ? { ok: false, message: `That didn't take (${(r.errors as string[] | undefined)?.join(", ") ?? "rejected"}).` }
        : check.action === "close"
          ? { ok: true, message: `${check.id} is done.`, page: `task/${check.id}`, undo: { action: "reopen", fields: { id: check.id } } }
          : { ok: true, message: `${check.id} is open again.`, page: `task/${check.id}` };
    }
  }
  uiStore.close();
  // Written in full, then exit: the rest of this file is the command path.
  writeAll(JSON.stringify(out) + "\n");
  process.exit(0);
}

/**
 * TASKSTORE_ON_OWNER_COMMENT: a command as a JSON array of strings, "{id}"
 * standing for the task, run (detached, no shell) when the owner comments from
 * loom's page: a wake for the agent, say. True when it was started.
 */
function onOwnerComment(id: string): boolean {
  const raw = process.env.TASKSTORE_ON_OWNER_COMMENT?.trim();
  if (!raw) return false;
  let argv: unknown;
  try { argv = JSON.parse(raw); } catch { return false; }
  if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === "string")) return false;
  const args = (argv as string[]).map((a) => a.split("{id}").join(id));
  try {
    const child = spawn(args[0], args.slice(1), { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch { return false; }
}

checkKnownFlags();
const command = buildCommand();
mkdirSync(dirname(dbPath), { recursive: true });
const store = new SqliteStore(dbPath);
const result = store.run(command);
store.close();

// Echo the edge in words on link/unlink. Direction is the other silent
// mistake on this verb — `link A B` means A depends on B, and a reversed pair
// is accepted, valid and wrong — and for unlink it is what turns removed into
// something an operator reads. Stating the relation at the moment it is
// written puts the gating in front of the caller rather than leaving it to be
// discovered later in a ready queue that quietly lost a row.
if ((command.op === "link" || command.op === "unlink") && result.ok === true) {
  const rel = command.type === "parent-child" ? "CHILD OF" : "BLOCKED BY";
  const a = String(command.id);
  const b = String(command.dependsOn);
  // A miss must not read as reassurance. The same removed:false covers a
  // reversed pair, the wrong --type, an edge that never existed and a plain
  // repeat, and only the last is benign — so the line names what did NOT
  // happen and points at the two ways to have got here wrong, rather than
  // stating a fact about the store that sounds like the requested outcome.
  result.edge =
    command.op === "link"
      ? result.linked === true
        ? `${a} is now ${rel} ${b}`
        : `ALREADY LINKED: ${String(command.type)} edge from ${a} to ${b} already exists`
      : result.removed === true
        ? `${a} is no longer ${rel} ${b}`
        : `NOTHING REMOVED: no ${String(command.type)} edge from ${a} to ${b} (check the direction and --type)`;
}

console.log(JSON.stringify(result, null, 2));

// An unlink that removed nothing exits NON-ZERO even though the command is
// contract-valid and ok true. The core is right to accept it — that keeps
// unlink idempotent, so replaying a mirror never fails on an edge already
// gone — but at the CLI the four ways to get removed false are a reversed
// pair, the wrong --type, an edge that never existed, and a genuine repeat,
// and only the last is benign. Exiting 0 would put the miss behind `&&`,
// `set -e` and every CI step. The symmetric case on link: a duplicate link
// exits 3 to match — the edge already existed and nothing changed; a caller
// who expected to write a new constraint should know. it-ts-links leaves the
// exit status of both no-ops to the binding; this binding treats both as failure.
// Exit codes are distinct on purpose. Collapsing the miss into 1 would tell a
// caller only "not ok", conflating an INVALID command with a valid one that
// found nothing to do — and the JSON says ok true while the process says
// failure, so the status has to carry the difference. 0 did the work, 3 the
// command was fine but the edge was already in the expected state (no-op),
// 1 the command was rejected, 2 usage.
const missedUnlink = command.op === "unlink" && result.ok === true && result.removed !== true;
const dupLink = command.op === "link" && result.ok === true && result.linked !== true;
// SET the status; do not process.exit() on it. stdout to a pipe is written
// through a non-blocking fd: a write larger than the 64 KiB buffer is queued
// and drained on later ticks, and process.exit() ends the process without
// draining, discarding the rest at exit 0. `taskstore export` measured
// 1,768,451 bytes to a file and exactly 65,536 down a pipe on 2026-09-08 —
// so `taskstore export | gzip > backup.gz` was writing a 4%-complete backup
// of the exit door and reporting success. A file fd is written synchronously,
// which is the only reason this was survivable long enough to ship.
// Nothing holds the loop open here: the store is closed above and
// better-sqlite3 is synchronous, so the process still ends as soon as stdout
// is flushed — with the whole output and the same four statuses.
process.exitCode = result.ok !== true ? 1 : missedUnlink || dupLink ? 3 : 0;
