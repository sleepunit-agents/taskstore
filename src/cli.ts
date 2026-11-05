#!/usr/bin/env node
// The taskstore CLI — agent-first binding over the pure core. Every verb is
// one contract command; output is JSON on stdout (jq-friendly). The clock
// and actor are binding-supplied here (TASKSTORE_ACTOR, or "art"): the CLI
// is the impure shell around the pure transitions.
//
//   taskstore ready
//   taskstore create "title" [--description d] [--type t] [--priority n]
//                    [--parent id] [--spec-item-ref r] [--criterion-id c]
//                    [--legacy-ref r] [plain flags]
//     plain flags (create and update; src/plain.ts lints them):
//       --goal g --why w --done-when d          the plain summary
//       --ask a --if-yes y --if-no n --answers yes-no|words   the owner's ask
//     A task that's the owner's (TASKSTORE_OWNER, else jonathan) is refused
//     until it reads plainly and has an --ask; any other is written, with
//     "warnings" in the answer when it doesn't read plainly or has no --goal.
//   taskstore claim <id> | close <id> [--reason r] | reopen <id> | delete <id>
//   taskstore update <id> --title t | --description d | --priority n | --assignee a | plain flags
//     ("" clears a plain flag's field; --ask "" clears the ask and its parts)
//   taskstore comment <id> "text" | comment <id> --file <path>   (--file - reads stdin)
//     Long text belongs in a file or on stdin: inline, the shell (or a harness's
//     command checker) has to read backticks and $( ) inside the quotes.
//   taskstore link <id> <dependsOn> --type blocks|parent-child
//   taskstore unlink <id> <dependsOn> --type blocks|parent-child
//     exit 0 removed, 3 valid but no such edge, 1 rejected, 2 usage
//   taskstore show <id> | list [--status s] | search <query> [--status s] | report | export
//   taskstore import <payload.json>
//   taskstore ui [page|act] --json   (loom's page; see src/loom-ui.ts)
//   taskstore api --json             (loom's piece API; see src/loom-api.ts)
//   taskstore project-feed --json --project <slug> --since <iso> [--epic <id>]
//                    [--name <alias>]... [--venue <v>]...
//                                    (loom's project hub; see src/project-feed.ts)
//
// Store path: $TASKSTORE_DB, else ./.taskstore/store.db relative to cwd.

import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import Database from "better-sqlite3";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SqliteStore } from "./sqlite-store.js";
import type { Command, Link, Task } from "./core.js";
import { changeRefs, checkAct, manifest, page, priorityWord, type ChangeRef, type ReadyEntry, type UiView } from "./loom-ui.js";
import { answer, type ApiRequest } from "./loom-api.js";
import { describe as describeFinding, EXAMPLE, lint, PLAIN_RULE, type Finding, type PlainField } from "./plain.js";
import { feed, parseFeedArgs } from "./project-feed.js";
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

// The flags each verb actually reads. A flag outside this set used to be
// parsed into `flags` and then silently dropped — buildCommand only ever
// looks up the keys it knows about, so a typo (--typ for --type) or a
// stray flag (--bogus) vanished with no error, same failure class the
// --type default used to be (see the link/unlink comment below): a
// malformed command read back as a valid, narrower one. Unknown verbs are
// already caught by the switch's default case; this catches unknown FLAGS
// on a verb that otherwise matched.
/** The plain flags (create and update), by the core field each one sets. */
const PLAIN_FLAGS: Record<string, string> = {
  goal: "goal", why: "why", "done-when": "doneWhen", ask: "ask", "if-yes": "ifYes", "if-no": "ifNo", answers: "answers",
};
const KNOWN_FLAGS: Record<string, Set<string>> = {
  create: new Set(["description", "type", "priority", "parent", "spec-item-ref", "criterion-id", "legacy-ref", ...Object.keys(PLAIN_FLAGS)]),
  claim: new Set(),
  unclaim: new Set(),
  close: new Set(["reason"]),
  reopen: new Set(),
  delete: new Set(),
  update: new Set(["title", "description", "assignee", "priority", ...Object.keys(PLAIN_FLAGS)]),
  comment: new Set(["file"]),
  link: new Set(["type"]),
  unlink: new Set(["type"]),
  show: new Set(),
  list: new Set(["status"]),
  search: new Set(["status"]),
  ready: new Set(),
  report: new Set(),
  export: new Set(),
  import: new Set(),
};

function checkKnownFlags(): void {
  // Object.hasOwn, not a bare KNOWN_FLAGS[verb]: a caller-controlled verb
  // string can name an inherited Object.prototype member (toString,
  // constructor, valueOf, hasOwnProperty, ...). Without this check `taskstore
  // toString --x y` binds `allowed` to that inherited function, `allowed.has`
  // throws an uncaught TypeError, and the command exits 1 with a stack trace
  // instead of the switch default's clean "unknown verb" / exit 2.
  const allowed = verb !== undefined && Object.hasOwn(KNOWN_FLAGS, verb) ? KNOWN_FLAGS[verb] : undefined;
  if (!allowed) return; // unknown verb: the switch's default case owns this error
  const unknown = Object.keys(flags).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    const plural = unknown.length > 1 ? "s" : "";
    console.error(`unknown flag${plural} for '${verb}': ${unknown.map((k) => `--${k}`).join(", ")}`);
    process.exit(2);
  }
}

function buildCommand(): Command {
  switch (verb) {
    case "create": {
      const c: Command = { op: "create", title: positional[0], actor, at };
      if (flags.description !== undefined) c.description = flags.description;
      if (flags.type !== undefined) c.type = flags.type;
      if (flags.priority !== undefined) c.priority = Number(flags.priority);
      if (flags.parent !== undefined) c.parent = flags.parent;
      if (flags["spec-item-ref"] !== undefined) c.specItemRef = flags["spec-item-ref"];
      if (flags["criterion-id"] !== undefined) c.criterionId = flags["criterion-id"];
      if (flags["legacy-ref"] !== undefined) c.legacyRef = flags["legacy-ref"];
      for (const [flag, key] of Object.entries(PLAIN_FLAGS)) if (flags[flag] !== undefined) c[key] = flags[flag];
      return c;
    }
    case "claim":
      return { op: "claim", id: positional[0], actor, at };
    case "unclaim":
      return { op: "unclaim", id: positional[0], actor, at };
    case "close": {
      const c: Command = { op: "close", id: positional[0], actor, at };
      if (flags.reason !== undefined) c.reason = flags.reason;
      return c;
    }
    case "reopen":
      return { op: "reopen", id: positional[0], actor, at };
    case "delete":
      return { op: "delete", id: positional[0], actor, at };
    case "update": {
      const set: Record<string, unknown> = {};
      for (const k of ["title", "description", "assignee"]) if (flags[k] !== undefined) set[k] = flags[k];
      if (flags.priority !== undefined) set.priority = Number(flags.priority);
      for (const [flag, key] of Object.entries(PLAIN_FLAGS)) if (flags[flag] !== undefined) set[key] = flags[flag];
      return { op: "update", id: positional[0], set, actor, at };
    }
    case "comment": {
      // --file <path>, or --file - for stdin: the text as it is, no shell quoting.
      // Not both: a text and a file would leave which one landed to a guess.
      if (flags.file !== undefined) {
        if (positional[1] !== undefined) {
          console.error("taskstore: comment takes its text inline or from --file, not both");
          process.exit(2);
        }
        if (flags.file === "") {
          console.error("taskstore: --file needs a path (or - for stdin)");
          process.exit(2);
        }
        // A rejection answers like every other one: JSON on stdout (ok: false), exit 1.
        const reject = (code: string, message: string): never => {
          console.error(`taskstore: ${message}`);
          writeAll(JSON.stringify({ ok: false, errors: [code], message }, null, 2) + "\n");
          process.exit(1);
        };
        let text = "";
        try {
          text = readFileSync(flags.file === "-" ? 0 : flags.file, "utf8");
        } catch (err) {
          reject("E_FILE", `can't read --file ${flags.file}: ${(err as Error).message}`);
        }
        // One trailing newline is the file's (a heredoc, an editor), not the comment's: "\n", or "\r\n" from a
        // CRLF file. Anything else is kept as written.
        text = text.replace(/\r?\n$/, "");
        // An empty file is most likely a redirect that produced nothing, not a comment anyone meant.
        if (text.trim() === "") reject("E_EMPTY", `--file ${flags.file} has no text`);
        return { op: "comment", id: positional[0], text, actor, at };
      }
      return { op: "comment", id: positional[0], text: positional[1], actor, at };
    }
    // --type is passed through ABSENT when absent. It used to default to
    // "blocks", which meant a missing flag silently built the edge that gates
    // the ready queue; the core has always required the field (E_MISSING_FIELD)
    // and the binding was overriding that refusal with the destructive choice.
    case "link":
      return { op: "link", id: positional[0], dependsOn: positional[1], type: flags.type, actor, at };
    case "unlink":
      return { op: "unlink", id: positional[0], dependsOn: positional[1], type: flags.type, actor, at };
    case "show":
      return { op: "show", id: positional[0] };
    case "list": {
      const c: Command = { op: "list" };
      if (flags.status !== undefined) c.status = flags.status;
      return c;
    }
    case "search": {
      const c: Command = { op: "search", q: positional[0] };
      if (flags.status !== undefined) c.status = flags.status;
      return c;
    }
    case "ready":
      return { op: "ready" };
    case "report":
      return { op: "report" };
    case "export":
      return { op: "export" };
    case "import": {
      const payload = JSON.parse(readFileSync(positional[0], "utf8")) as Record<string, unknown>;
      return { op: "import", tasks: payload.tasks, links: payload.links, actor, at };
    }
    default:
      console.error(
        "usage: taskstore <create|claim|unclaim|close|reopen|delete|update|comment|link|unlink|show|list|search|ready|report|export|import> ...",
      );
      // This exit() stays, unlike the one at the end of the file. It is the
      // only way out of a branch that owes the caller a Command and has none
      // — setting process.exitCode here would fall through and run the whole
      // command path on `undefined`. It is also safe on the grounds the other
      // one was not: nothing has been written to stdout yet, and the single
      // short line above fits any pipe buffer, so there is no queued write to
      // discard.
      process.exit(2);
  }
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
      owner, now: new Date(), timeZone: process.env.TZ || undefined, agents: agentsSetting(),
    };
  };
  let out: unknown;
  // A task's page lists the changes that cite it when the Changes piece is installed (loom docs/specs/changes.md,
  // "Linked tasks"): `loom-changes cited-by <id> --json`, read-only, 1.5 s at most; anything else means no section.
  const citedBy = (id: string): ChangeRef[] | undefined => {
    // Only an absolute path is ever run: never one resolved against the working directory.
    const home = process.env.LOOM_HOME || join(homedir(), ".config", "loom");
    const bin = process.env.TASKSTORE_CHANGES || join(home, "pieces", "bin", "loom-changes");
    // The Changes piece cites tasks as t-<digits> (its word rule), so only such an id can have changes; the guard
    // also keeps the argument a plain token.
    if (!isAbsolute(bin) || !/^t-[0-9]+$/.test(id) || !existsSync(bin)) return undefined;
    const r = spawnSync(bin, ["cited-by", id, "--json"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] });
    try {
      return r.status === 0 ? changeRefs(JSON.parse(r.stdout)) : undefined;
    } catch {
      return undefined;
    }
  };
  if (sub === "") out = manifest(read());
  else if (sub === "page") {
    const req = request();
    const path = req && typeof req === "object" ? (req as { path?: unknown }).path : undefined;
    const m = typeof path === "string" ? /^task\/([^/]+)$/.exec(path) : null;
    const changes = m ? citedBy(m[1]) : undefined;
    out = page({ ...read(), ...(changes ? { changes } : {}) }, req);
  }
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
        const agent = agentsSetting()[0];
        const task = (uiStore.run({ op: "show", id: check.id }) as { task?: { assignee?: string } }).task;
        if (agent && task?.assignee === owner) uiStore.run({ op: "update", id: check.id, set: { assignee: agent }, actor: owner, at } as Command);
        if (onOwnerComment(check.id)) message = `Comment added. ${agent ? agent[0].toUpperCase() + agent.slice(1) : "An agent"} picks it up.`;
      }
      out = r.ok === true
        ? { ok: true, message, page: `task/${check.id}` }
        : { ok: false, message: `The comment wasn't added (${(r.errors as string[] | undefined)?.join(", ") ?? "rejected"}).` };
    } else if (check.action === "answer") {
      // The owner answered the ask (Yes, No, or words): their comment, the task back to the agent that asked, and that
      // agent woken (TASKSTORE_ON_OWNER_COMMENT), as a reply from the page does.
      const at = new Date().toISOString();
      const r = uiStore.run({ op: "comment", id: check.id, text: check.text, actor: owner, at });
      if (r.ok === true) uiStore.run({ op: "update", id: check.id, set: { assignee: check.to }, actor: owner, at } as Command);
      const woke = r.ok === true && onOwnerComment(check.id);
      const who = check.to[0].toUpperCase() + check.to.slice(1);
      const said = check.answer === "yes" ? "You said yes." : check.answer === "no" ? "You said no." : "Sent.";
      out = r.ok === true
        ? { ok: true, message: `${said} ${woke ? `${who} picks it up.` : `It's back with ${who}.`}`, page: `task/${check.id}` }
        : { ok: false, message: `Your answer wasn't saved (${(r.errors as string[] | undefined)?.join(", ") ?? "rejected"}).` };
    } else if (check.action === "priority") {
      // The facts panel's segmented control: the priority, in place.
      const r = uiStore.run({ op: "update", id: check.id, set: { priority: check.priority }, actor: owner || "loom-page", at: new Date().toISOString() } as Command);
      out = r.ok === true
        ? { ok: true, message: `${check.id} is ${priorityWord(check.priority).toLowerCase()} priority now.`, page: `task/${check.id}` }
        : { ok: false, message: `That didn't take (${(r.errors as string[] | undefined)?.join(", ") ?? "rejected"}).` };
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

// `project-feed`: the tasks section of a loom project's hub (src/project-feed.ts,
// loom docs/specs/projects.md "Section feeds"). A read, of a store that already
// exists (as `ui`: loom runs it from its own working directory). Its own
// argument parser, since --name and --venue repeat.
if (verb === "project-feed") {
  const args = parseFeedArgs(argv);
  if (typeof args === "string") {
    console.error(`taskstore project-feed: ${args}`);
    process.exit(2);
  }
  if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
    console.error(`taskstore: no store at ${dbPath} (set TASKSTORE_DB)`);
    process.exit(1);
  }
  const feedStore = new SqliteStore(dbPath);
  const all = feedStore.run({ op: "export" }) as { tasks?: Task[]; links?: Link[] };
  const ready = feedStore.run({ op: "ready" }) as { entries?: ReadyEntry[] };
  feedStore.close();
  const out = feed(
    { tasks: all.tasks ?? [], links: all.links ?? [], ready: ready.entries ?? [], owner: process.env.TASKSTORE_OWNER?.trim() || "" },
    args,
  );
  writeAll(JSON.stringify(out) + "\n");
  process.exit(0);
}

/** TASKSTORE_AGENTS, in order. */
function agentsSetting(): string[] {
  return (process.env.TASKSTORE_AGENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
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
// Plain words (src/plain.ts): read before the write, so an owner's task that
// doesn't read plainly is refused with nothing written.
const plainCheck = plainWords(store, command);
let result: Record<string, unknown>;
if (plainCheck.refuse) {
  result = {
    ok: false, errors: ["E_NOT_PLAIN"],
    message: `${plainCheck.refuse} ${PLAIN_RULE} Say it again in words, like:\n${EXAMPLE}`,
    found: plainCheck.findings.map(describeFinding),
  };
  console.error(`taskstore: refused: ${plainCheck.refuse}`);
} else {
  try {
    result = store.run(command);
  } catch (err) {
    // The store couldn't apply it: the write lock didn't come in time
    // (SQLITE_BUSY), the disk is full, the mirror couldn't be written. The
    // write rolled back, so this is a failure, said as one — never an ok.
    const e = err as { code?: unknown; message?: unknown };
    result = { ok: false, errors: ["E_STORE"], message: `the store couldn't apply this ${command.op}: ${String(e.message ?? err)}`, ...(typeof e.code === "string" ? { code: e.code } : {}) };
    console.error(`taskstore: ${result.message}`);
  }
  if (result.ok === true && plainCheck.warnings.length) {
    result.warnings = plainCheck.warnings;
    for (const w of plainCheck.warnings) console.error(`taskstore: warning: ${w}`);
  }
}
store.close();

/**
 * The plain-words policy over a create or update. The owner's task (assigned
 * to TASKSTORE_OWNER, else jonathan) is refused when what it's given doesn't
 * read plainly, or when it becomes the owner's with no ask: a person reads
 * it, so it says what's asked. Any other task is written regardless, and
 * the answer carries warnings: an agent filing work mid-lane loses nothing.
 * Only what this command sets is read, plus the whole headline when the task
 * becomes the owner's: a priority bump on an old task isn't held up by its title.
 */
function plainWords(s: SqliteStore, c: Command): { refuse?: string; findings: Finding[]; warnings: string[] } {
  const none = { findings: [], warnings: [] };
  if (c.op !== "create" && c.op !== "update") return none;
  const owner = process.env.TASKSTORE_OWNER?.trim() || "jonathan";
  const given: Record<string, unknown> = c.op === "create" ? c : ((c.set as Record<string, unknown> | undefined) ?? {});
  const before = c.op === "update" && typeof c.id === "string"
    ? ((s.run({ op: "show", id: c.id }) as { task?: Task }).task)
    : undefined;
  if (c.op === "update" && !before) return none; // the core reports the unknown id
  const after = { ...(before ?? {}), ...given } as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const fields: PlainField[] = ["title", "goal", "why", "doneWhen", "ask", "ifYes", "ifNo"];
  const becomesOwners = after.assignee === owner && before?.assignee !== owner;
  const read: Partial<Record<PlainField, string>> = {};
  for (const f of fields) {
    const v = becomesOwners && (f === "title" || f === "ask") ? str(after[f]) : str(given[f]);
    if (v !== undefined) read[f] = v;
  }
  const findings = lint(read);
  const isOwners = after.assignee === owner;
  const askLeft = !str(after.ask);
  if (isOwners && (findings.length || (askLeft && (becomesOwners || given.ask !== undefined)))) {
    const why = findings.length
      ? `This task is ${owner}'s to read, and ${findings.map(describeFinding).join("; ")}.`
      : `This task is ${owner}'s: give it an --ask (one plain question; --if-yes and --if-no say what happens either way).`;
    return { refuse: why, findings, warnings: [] };
  }
  const warnings = findings.map((f) => `${describeFinding(f)}: it will read as jargon on the task list`);
  const touchesHeadline = c.op === "create" || given.title !== undefined || given.goal !== undefined;
  if (touchesHeadline && !str(after.goal)) warnings.push("needs a plain summary: give it a --goal (what's true when it's done) and a --why");
  if (warnings.length) warnings.push(`the plain form, like:\n${EXAMPLE}`);
  return { findings, warnings };
}

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
