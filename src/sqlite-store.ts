// SQLite binding: persists StoreState in one WAL-mode database file and
// mirrors a passive JSONL export next to it after every mutation — the exit
// door stays open BY CONSTRUCTION (write-through, never periodic; the
// brownfield predecessor's mirror went stale by being an afterthought).
// The binding owns persistence only; every behavior is the pure core's.

import Database from "better-sqlite3";
import { writeFileSync, renameSync } from "node:fs";
import { apply, emptyState, type Command, type Result, type StoreState, type Task, type Link } from "./core.js";

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
    if (result.ok === true && command.op !== "show" && command.op !== "list" &&
        command.op !== "ready" && command.op !== "report" && command.op !== "export")
      this.persist(state);
    return result;
  }

  close(): void {
    this.db.close();
  }
}
