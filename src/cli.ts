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
//   taskstore link <id> <dependsOn> [--type blocks|parent-child]
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
    case "link":
      return { op: "link", id: positional[0], dependsOn: positional[1], type: flags.type ?? "blocks", actor, at };
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
        "usage: taskstore <create|claim|close|reopen|delete|update|comment|link|show|list|search|ready|report|export|import> ...",
      );
      process.exit(2);
  }
}

const command = buildCommand();
mkdirSync(dirname(dbPath), { recursive: true });
const store = new SqliteStore(dbPath);
const result = store.run(command);
store.close();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok === true ? 0 : 1);
