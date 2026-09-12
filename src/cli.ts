#!/usr/bin/env node
// The taskstore CLI — agent-first binding over the pure core. Every verb is
// one contract command; output is JSON on stdout (jq-friendly). The clock
// and actor are binding-supplied here (TASKSTORE_ACTOR, or "art"): the CLI
// is the impure shell around the pure transitions.
//
//   taskstore ready
//   taskstore create "title" [--description d] [--type t] [--priority n]
//                    [--parent id] [--spec-item-ref r] [--criterion-id c]
//   taskstore claim <id> | close <id> [--reason r] | reopen <id> | delete <id>
//   taskstore update <id> --title t | --description d | --priority n | --assignee a
//   taskstore comment <id> "text"
//   taskstore link <id> <dependsOn> --type blocks|parent-child
//   taskstore unlink <id> <dependsOn> --type blocks|parent-child
//     exit 0 removed, 3 valid but no such edge, 1 rejected, 2 usage
//   taskstore show <id> | list [--status s] | search <query> [--status s] | report | export
//   taskstore import <payload.json>
//
// Store path: $TASKSTORE_DB, else ./.taskstore/store.db relative to cwd.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SqliteStore } from "./sqlite-store.js";
import type { Command } from "./core.js";

const argv = process.argv.slice(2);
const verb = argv.shift();

const positional: string[] = [];
const flags: Record<string, string> = {};
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
      return { op: "update", id: positional[0], set, actor, at };
    }
    case "comment":
      return { op: "comment", id: positional[0], text: positional[1], actor, at };
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
// who expected to write a new constraint should know. it-ts-links licenses
// treating both as failure here.
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
