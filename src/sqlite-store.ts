// SQLite binding: persists StoreState in one WAL-mode database file and
// mirrors a passive JSONL export next to it after every mutation — the exit
// door stays open BY CONSTRUCTION (write-through, never periodic; the
// brownfield predecessor's mirror went stale by being an afterthought).
// The binding owns persistence only; every behavior is the pure core's.

import Database from "better-sqlite3";
import { writeFileSync, renameSync, appendFileSync } from "node:fs";
import { apply, emptyState, type Command, type Result, type StoreState, type Task, type Link } from "./core.js";

const MUTATION_OPS = new Set([
  "create", "claim", "unclaim", "close", "reopen", "delete",
  "update", "comment", "link", "unlink", "import",
]);

interface FieldChange {
  old: unknown;
  new: unknown;
}

interface InteractionRecord {
  at: string;
  actor: string;
  op: string;
  task_id: string | null;
  diff: Record<string, FieldChange>;
}

const TASK_DIFF_FIELDS = [
  "status", "title", "description", "priority", "type",
  "assignee", "startedAt", "closedAt", "closeReason",
] as const;

function taskFieldDiff(prev: Task, next: Task): Record<string, FieldChange> {
  const diff: Record<string, FieldChange> = {};
  const p = prev as unknown as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;
  for (const f of TASK_DIFF_FIELDS) {
    const o = p[f] ?? null;
    const nv = n[f] ?? null;
    if (JSON.stringify(o) !== JSON.stringify(nv)) diff[f] = { old: o, new: nv };
  }
  if (prev.comments.length !== next.comments.length)
    diff.comment = { old: null, new: next.comments[next.comments.length - 1] };
  return diff;
}

function buildInteractions(
  command: Command,
  prev: StoreState,
  state: StoreState,
  result: Result,
): InteractionRecord[] {
  const at = command.at as string;
  const actor = command.actor as string;
  const op = command.op;

  switch (op) {
    case "create": {
      if (result.created === false) return []; // idempotent hit — state unchanged
      const task_id = result.id as string;
      const task = state.tasks.find((t) => t.id === task_id);
      const diff: Record<string, FieldChange> = {};
      if (task) {
        const t = task as unknown as Record<string, unknown>;
        for (const f of TASK_DIFF_FIELDS) {
          const val = t[f];
          if (val !== undefined) diff[f] = { old: null, new: val };
        }
      }
      return [{ at, actor, op, task_id, diff }];
    }

    case "claim":
    case "unclaim":
    case "close":
    case "reopen": {
      const task_id = command.id as string;
      const prevTask = prev.tasks.find((t) => t.id === task_id)!;
      const nextTask = state.tasks.find((t) => t.id === task_id)!;
      return [{ at, actor, op, task_id, diff: taskFieldDiff(prevTask, nextTask) }];
    }

    case "delete":
      return [{ at, actor, op, task_id: command.id as string, diff: {} }];

    case "update":
    case "comment": {
      const task_id = command.id as string;
      const prevTask = prev.tasks.find((t) => t.id === task_id)!;
      const nextTask = state.tasks.find((t) => t.id === task_id)!;
      return [{ at, actor, op, task_id, diff: taskFieldDiff(prevTask, nextTask) }];
    }

    case "link": {
      if (result.linked === false) return []; // duplicate no-op — state unchanged
      const task_id = command.id as string;
      const newLink = state.links.find(
        (l) => l.id === task_id && l.dependsOn === command.dependsOn && l.type === command.type,
      );
      return [{ at, actor, op, task_id, diff: { link: { old: null, new: newLink ?? null } } }];
    }

    case "unlink": {
      if (result.removed === false) return []; // no edge present — state unchanged
      const task_id = command.id as string;
      const removedLink = prev.links.find(
        (l) => l.id === task_id && l.dependsOn === command.dependsOn && l.type === command.type,
      );
      return [{ at, actor, op, task_id, diff: { link: { old: removedLink ?? null, new: null } } }];
    }

    case "import": {
      const prevIds = new Set(prev.tasks.map((t) => t.id));
      return state.tasks
        .filter((t) => !prevIds.has(t.id))
        .map((task) => ({ at, actor, op, task_id: task.id, diff: {} as Record<string, FieldChange> }));
    }

    default:
      return [];
  }
}

export class SqliteStore {
  private db: Database.Database;

  constructor(private dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        ord INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS links (
        ord INTEGER PRIMARY KEY,
        record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  load(): StoreState {
    const state = emptyState();
    for (const row of this.db.prepare("SELECT record FROM tasks ORDER BY ord").all() as { record: string }[])
      state.tasks.push(JSON.parse(row.record) as Task);
    for (const row of this.db.prepare("SELECT record FROM links ORDER BY ord").all() as { record: string }[])
      state.links.push(JSON.parse(row.record) as Link);
    const seq = this.db.prepare("SELECT value FROM meta WHERE key = 'seq'").get() as { value: string } | undefined;
    state.seq = seq ? Number(seq.value) : 0;
    return state;
  }

  private persist(state: StoreState): void {
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM tasks; DELETE FROM links;");
      const insT = this.db.prepare("INSERT INTO tasks (ord, id, record) VALUES (?, ?, ?)");
      state.tasks.forEach((t, i) => insT.run(i, t.id, JSON.stringify(t)));
      const insL = this.db.prepare("INSERT INTO links (ord, record) VALUES (?, ?)");
      state.links.forEach((l, i) => insL.run(i, JSON.stringify(l)));
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(state.seq));
    });
    tx();
    this.mirror(state);
  }

  /** Passive append-only interactions log: one mutation record per line. */
  private appendInteractions(entries: InteractionRecord[]): void {
    if (entries.length === 0) return;
    const path = this.dbPath.replace(/\.db$/, "") + ".interactions.jsonl";
    appendFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  /** Passive JSONL mirror: one task record per line, then one link record per line. */
  private mirror(state: StoreState): void {
    const path = this.dbPath.replace(/\.db$/, "") + ".export.jsonl";
    const lines = [
      ...state.tasks.map((t) => JSON.stringify({ record: "task", ...t })),
      ...state.links.map((l) => JSON.stringify({ record: "link", ...l })),
    ];
    const tmp = path + ".tmp";
    writeFileSync(tmp, lines.join("\n") + (lines.length ? "\n" : ""));
    renameSync(tmp, path);
  }

  run(command: Command): Result {
    const prev = this.load();
    const { result, state } = apply(prev, command);
    if (result.ok === true && MUTATION_OPS.has(command.op)) {
      this.persist(state);
      this.appendInteractions(buildInteractions(command, prev, state, result));
    }
    return result;
  }

  close(): void {
    this.db.close();
  }
}
