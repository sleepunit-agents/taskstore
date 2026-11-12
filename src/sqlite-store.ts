// SQLite binding: persists StoreState in one WAL-mode database file and
// mirrors a passive JSONL export next to it after every mutation — the exit
// door stays open BY CONSTRUCTION (write-through, never periodic; the
// brownfield predecessor's mirror went stale by being an afterthought).
// The binding owns persistence only; every behavior is the pure core's.

import { randomBytes } from "node:crypto";
import { keptRecords, loggedRecord, type TaskRecord } from "./collections.js";
import Database from "better-sqlite3";
import { writeFileSync, renameSync, appendFileSync, existsSync, statSync, truncateSync } from "node:fs";
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
  "goal", "why", "doneWhen", "ask", "ifYes", "ifNo", "answers", "askedBy", "source",
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

/**
 * How long a writer waits for another writer's transaction before it gives
 * up and fails (SQLITE_BUSY). Writes are a few milliseconds each; a wait this
 * long means something is wedged, and the caller hears about it as a failure.
 */
const BUSY_TIMEOUT_MS = 30_000;

export class SqliteStore {
  /** Whether any run on this store committed changes visible to task collections. */
  collectionChanged = false;
  private db: Database.Database;

  constructor(private dbPath: string) {
    // The busy timeout goes on at open, before the first statement: setting
    // WAL and creating the schema both take the write lock, and a second
    // process opening the store at the same moment must wait, not throw.
    this.db = new Database(dbPath, { timeout: BUSY_TIMEOUT_MS });
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
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
      CREATE TABLE IF NOT EXISTS collection_changes (
        rev INTEGER PRIMARY KEY AUTOINCREMENT,
        txn TEXT NOT NULL,
        id TEXT NOT NULL,
        record TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('collection_origin', ?)").run(randomBytes(16).toString("hex"));
  }

  /** Kept-field differences include dependents. Heavy description changes signal a requery without logging text. */
  private logCollections(prev: StoreState, state: StoreState): boolean {
    let changed = false;
    const was = keptRecords(prev.tasks, prev.links);
    const next = keptRecords(state.tasks, state.links);
    const descriptions = new Map(prev.tasks.map(t => [t.id, t.description]));
    const changedDescriptions = new Set(state.tasks.filter(t => t.description !== descriptions.get(t.id)).map(t => t.id));
    const txn = randomBytes(16).toString("hex");
    const insert = this.db.prepare("INSERT INTO collection_changes (txn, id, record) VALUES (?, ?, ?)");
    for (const [id, record] of next) {
      const json = JSON.stringify(record);
      if (json !== JSON.stringify(was.get(id)) || changedDescriptions.has(id)) { insert.run(txn, id, json); changed = true; }
    }
    for (const id of was.keys()) if (!next.has(id)) { insert.run(txn, id, null); changed = true; }
    return changed;
  }

  /** Core-only source feed. Cursor identity detects restored/replaced histories, including re-grown ones. */
  collectionChanges(input: Record<string, unknown>, owner = ""): Record<string, unknown> {
    return this.db.transaction(() => {
      const origin = (this.db.prepare("SELECT value FROM meta WHERE key = 'collection_origin'").get() as { value: string }).value;
      const head = this.db.prepare("SELECT rev, txn FROM collection_changes ORDER BY rev DESC LIMIT 1").get() as { rev: number; txn: string } | undefined;
      const rev = head?.rev ?? 0;
      const txn = head?.txn ?? origin;
      const cursor = input["tasks/task"] as { rev?: unknown; txn?: unknown } | undefined;
      if (!cursor || typeof cursor !== "object") throw new Error("missing tasks/task cursor");
      if (cursor.rev === null) return { "tasks/task": { head: rev, txn, changes: [], more: false } };
      if (!Number.isSafeInteger(cursor.rev) || (cursor.rev as number) < 0 || typeof cursor.txn !== "string") throw new Error("invalid tasks/task cursor");
      const held = cursor.rev === 0 ? origin : (this.db.prepare("SELECT txn FROM collection_changes WHERE rev = ?").get(cursor.rev) as { txn: string } | undefined)?.txn;
      if (held !== cursor.txn) return { "tasks/task": { reset: true } };
      const limit = typeof input.limit === "number" && Number.isSafeInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 1000) : 1000;
      const rows = this.db.prepare("SELECT rev, txn, id, record FROM collection_changes WHERE rev > ? ORDER BY rev LIMIT ?").all(cursor.rev, limit + 1) as Array<{ rev: number; txn: string; id: string; record: string | null }>;
      // Core's offer accepts at most 4 MiB. Leave room for its envelope and paginate by
      // serialized UTF-8 bytes as well as count (kept text can be much larger than a task title).
      const changes: Array<Record<string, unknown>> = [];
      let bytes = 0;
      for (const r of rows.slice(0, limit)) {
        const change = { op: r.record === null ? "delete" : "upsert", id: r.id, rev: r.rev, txn: r.txn,
          ...(r.record === null ? {} : { audience: { owners: true }, record: loggedRecord(JSON.parse(r.record) as TaskRecord, owner) }) };
        const size = Buffer.byteLength(JSON.stringify(change), "utf8") + 1;
        if (bytes + size > 3 * 1024 * 1024) {
          if (!changes.length) throw new Error("collection change exceeds byte budget");
          break;
        }
        changes.push(change);
        bytes += size;
      }
      // End on a transaction boundary unless the first transaction itself is larger than a page.
      let end = changes.length;
      if (rows.length > end && end && rows[end - 1].txn === rows[end].txn) {
        let boundary = end;
        while (boundary > 0 && rows[boundary - 1].txn === rows[end].txn) boundary--;
        if (boundary) end = boundary;
      }
      changes.length = end;
      return { "tasks/task": { head: rev, txn, changes, more: rows.length > end } };
    })();
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

  /** The whole state back into the tables. Only ever inside run()'s write transaction. */
  private persist(state: StoreState): void {
    this.db.exec("DELETE FROM tasks; DELETE FROM links;");
    const insT = this.db.prepare("INSERT INTO tasks (ord, id, record) VALUES (?, ?, ?)");
    state.tasks.forEach((t, i) => insT.run(i, t.id, JSON.stringify(t)));
    const insL = this.db.prepare("INSERT INTO links (ord, record) VALUES (?, ?)");
    state.links.forEach((l, i) => insL.run(i, JSON.stringify(l)));
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(state.seq));
  }

  /** Passive append-only interactions log: one mutation record per line. */
  private appendInteractions(entries: InteractionRecord[]): () => void {
    if (entries.length === 0) return () => {};
    const path = this.dbPath.replace(/\.db$/, "") + ".interactions.jsonl";
    const bytes = existsSync(path) ? statSync(path).size : 0;
    const rollback = () => truncateSync(path, bytes);
    try { appendFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n"); }
    catch (err) { if (existsSync(path)) rollback(); throw err; }
    return rollback;
  }

  /**
   * Passive JSONL mirror: one task record per line, then one link record per
   * line. Written to a temp file of this process's own, and returned as a
   * commit step (the rename) so run() can put it last. The temp name used to
   * be shared: two writers' renames raced, and the loser threw ENOENT after
   * its write had committed — a write in the store reported as a failure.
   */
  private stageMirror(state: StoreState): () => void {
    const path = this.dbPath.replace(/\.db$/, "") + ".export.jsonl";
    const lines = [
      ...state.tasks.map((t) => JSON.stringify({ record: "task", ...t })),
      ...state.links.map((l) => JSON.stringify({ record: "link", ...l })),
    ];
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, lines.join("\n") + (lines.length ? "\n" : ""));
    return () => renameSync(tmp, path);
  }

  /**
   * One command. A mutation is one write transaction, BEGIN IMMEDIATE: it
   * takes the store's write lock first, THEN reads the state, applies the
   * core and writes back — so it always applies to what the last writer
   * committed. It used to read outside any transaction and write the whole
   * state back from that copy: under concurrent writers every write landing
   * between the read and the write was overwritten while its writer had
   * already been told ok (t-1831: ~20 of ~450 lost on the live store,
   * 2026-11-04; 442 of 773 in the 8x100 test before this change).
   *
   * The mirror and the interactions line are written inside the same
   * transaction, under the same lock, so they follow commit order. Anything
   * that fails — the lock not coming within BUSY_TIMEOUT_MS, a full disk —
   * throws, the transaction rolls back, and the caller never sees ok.
   */
  run(command: Command): Result {
    if (!MUTATION_OPS.has(command.op)) return apply(this.load(), command).result;
    const write = this.db.transaction(() => {
      const prev = this.load();
      const { result, state } = apply(prev, command);
      if (result.ok !== true) return { result, changed: false }; // nothing changes, nothing written
      this.persist(state);
      const changed = this.logCollections(prev, state);
      const publishMirror = this.stageMirror(state);
      const rollbackInteractions = this.appendInteractions(buildInteractions(command, prev, state, result));
      try { publishMirror(); }
      catch (err) { rollbackInteractions(); throw err; }
      return { result, changed };
    });
    const committed = write.immediate();
    this.collectionChanged ||= committed.changed;
    return committed.result;
  }

  close(): void {
    this.db.close();
  }
}
