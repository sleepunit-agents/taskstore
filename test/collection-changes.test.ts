import { describe, it, expect } from "vitest";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteStore } from "../src/sqlite-store.js";
import { keptRecords, loggedRecord } from "../src/collections.js";
import type { Command } from "../src/core.js";

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), "tasks-changes-")), "store.db");
  const store = new SqliteStore(path);
  let minute = 0;
  const run = (op: Record<string, unknown>) => {
    const r = store.run({ actor: "art", at: new Date(Date.UTC(2026, 10, 10, 0, minute++)).toISOString(), ...op } as Command);
    expect(r.ok).toBe(true);
    return r;
  };
  const pull = (rev: number | null = null, txn: string | null = null, limit = 1000): any => store.collectionChanges({ "tasks/task": { rev, txn }, limit }, "jonathan")["tasks/task"];
  return { path, store, run, pull };
}

describe("transactional Tasks source changes", () => {
  it("replays committed records and deletes with source audience, owner wording and no heavy text", () => {
    const { store, run, pull } = fixture();
    const start = pull();
    run({ op: "create", title: "First", description: "heavy secret body" });
    run({ op: "update", id: "t-1", set: { assignee: "jonathan", ask: "Is this ready?" } });
    run({ op: "create", title: "Gone" });
    run({ op: "delete", id: "t-2" });
    const got = pull(start.head, start.txn);
    expect(got.changes.map((c: any) => [c.op, c.id])).toEqual([["upsert", "t-1"], ["upsert", "t-1"], ["upsert", "t-2"], ["delete", "t-2"]]);
    expect(got.changes[0].record.assignee).toBeNull();
    expect(got.changes[1].record.refState).toMatchObject({ status: "Waiting on Jonathan", ownerStatus: "Waiting on you", owner: "jonathan" });
    expect(got.changes[0].audience).toEqual({ owners: true });
    expect(JSON.stringify(got)).not.toContain("heavy secret body");
    const held = new Map<string, unknown>();
    for (const c of got.changes) c.op === "delete" ? held.delete(c.id) : held.set(c.id, c.record);
    const state = store.load();
    expect(held).toEqual(new Map([...keptRecords(state.tasks, state.links)].map(([k, r]) => [k, loggedRecord(r, "jonathan")])));
    store.close();
  });

  it("logs every dependent with the same txn and honors page boundaries", () => {
    const { store, run, pull } = fixture();
    run({ op: "create", title: "Blocker" });
    for (let i = 0; i < 3; i++) {
      run({ op: "create", title: `Child ${i}` });
      run({ op: "link", id: `t-${i + 2}`, dependsOn: "t-1", type: "blocks" });
    }
    const start = pull();
    run({ op: "close", id: "t-1" });
    run({ op: "comment", id: "t-2", text: "Next transaction" });
    const first = pull(start.head, start.txn, 3);
    expect(first.more).toBe(true);
    expect(first.changes).toHaveLength(3); // one transaction larger than a page
    const last = first.changes.at(-1);
    const second = pull(last.rev, last.txn, 3);
    expect(second.changes[0].txn).toBe(last.txn);
    expect(second.changes[0].record.ready).toBe(true);
    expect(second.changes[1].txn).not.toBe(last.txn);
    expect(new Set([...first.changes, second.changes[0]].map((c: any) => c.txn)).size).toBe(1);
    expect([...first.changes, ...second.changes].map((c: any) => c.rev)).toEqual([start.head + 1, start.head + 2, start.head + 3, start.head + 4, start.head + 5]);
    store.close();
  });

  it("doesn't split an ordinary transaction and logs parent changes and no-op writes correctly", () => {
    const { store, run, pull } = fixture();
    run({ op: "create", title: "Parent" });
    run({ op: "create", title: "Child" });
    run({ op: "link", id: "t-2", dependsOn: "t-1", type: "blocks" });
    const start = pull();
    run({ op: "comment", id: "t-2", text: "Single" });
    run({ op: "close", id: "t-1" }); // blocker and dependent = two rows
    const first = pull(start.head, start.txn, 2);
    expect(first.changes).toHaveLength(1);
    expect(first.more).toBe(true);
    const l = first.changes[0];
    expect(pull(l.rev, l.txn, 2).changes).toHaveLength(2);
    const before = pull();
    run({ op: "link", id: "t-2", dependsOn: "t-1", type: "blocks" });
    expect(pull()).toEqual(before);
    run({ op: "link", id: "t-2", dependsOn: "t-1", type: "parent-child" });
    expect(pull(before.head, before.txn).changes[0].record.parent).toBe("t-1");
    store.close();
  });

  it("drains a backlog over core's 4 MiB budget in byte-bounded pages, preserving source transaction ids", () => {
    const { store, run, pull } = fixture();
    const start = pull();
    const text = "é".repeat(2500); // count UTF-8 bytes, not JS characters
    run({ op: "import", tasks: Array.from({ length: 1000 }, (_, i) => ({ id: `old-${i}`, title: `Imported ${i}`, goal: text, type: "task", status: "open", priority: 2, createdAt: "2026-11-10T00:00:00Z", createdBy: "art", comments: [] })) });
    let cursor = { rev: start.head, txn: start.txn };
    const changes: any[] = [];
    let pages = 0;
    for (; pages < 10; pages++) {
      const page = pull(cursor.rev, cursor.txn);
      expect(Buffer.byteLength(JSON.stringify({ "tasks/task": page }), "utf8")).toBeLessThan(4 * 1024 * 1024);
      changes.push(...page.changes);
      if (!page.more) break;
      const last = page.changes.at(-1);
      cursor = { rev: last.rev, txn: last.txn };
    }
    expect(pages).toBeGreaterThan(0);
    expect(changes).toHaveLength(1000);
    expect(new Set(changes.map((c) => c.id)).size).toBe(1000);
    expect(new Set(changes.map((c) => c.txn)).size).toBe(1);
    expect(changes.at(-1).rev).toBe(1000);
    store.close();
  });

  it("upgrades an existing store and exposes the log through the CLI without inventing historical changes", () => {
    const { path, store, run } = fixture();
    run({ op: "create", title: "Existing task" });
    store.close();
    const db = new Database(path);
    db.exec("DROP TABLE collection_changes; DELETE FROM meta WHERE key = 'collection_origin'");
    db.close();
    const call = (body: unknown) => spawnSync(process.execPath, ["dist/cli.js", "collections", "changes", "--json"], { encoding: "utf8", env: { ...process.env, TASKSTORE_DB: path }, input: JSON.stringify(body) });
    const initial = call({ "tasks/task": { rev: null, txn: null } });
    expect(initial.status).toBe(0);
    const head = JSON.parse(initial.stdout)["tasks/task"];
    expect(head).toMatchObject({ head: 0, changes: [], more: false });
    const next = new SqliteStore(path);
    next.run({ op: "update", id: "t-1", set: { title: "Changed" }, actor: "art", at: "2026-11-10T02:00:00Z" });
    next.close();
    const delta = call({ "tasks/task": { rev: head.head, txn: head.txn } });
    expect(delta.status).toBe(0);
    expect(JSON.parse(delta.stdout)["tasks/task"].changes[0].record.title).toBe("Changed");
    expect(call({ "tasks/task": { rev: -1, txn: "invalid" } }).status).toBe(1);
  });

  it("rolls the log back with the state when a write fails", () => {
    const { path, store, run, pull } = fixture();
    run({ op: "create", title: "Before" });
    const before = pull();
    const db = new Database(path);
    db.exec("CREATE TRIGGER reject_change BEFORE INSERT ON collection_changes BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    expect(() => run({ op: "update", id: "t-1", set: { title: "After" } })).toThrow();
    expect(store.load().tasks[0].title).toBe("Before");
    expect(pull()).toEqual(before);
    db.close(); store.close();
  });

  it("resets a cursor from a different or restored-and-regrown history", () => {
    const { path, store, run, pull } = fixture();
    run({ op: "create", title: "Base" });
    const backup = `${path}.backup`;
    const db = new Database(path);
    db.pragma("wal_checkpoint(TRUNCATE)");
    copyFileSync(path, backup);
    run({ op: "comment", id: "t-1", text: "Lost branch" });
    const old = pull();
    store.close(); db.close();
    copyFileSync(backup, path);
    const restored = new SqliteStore(path);
    restored.run({ op: "comment", id: "t-1", text: "New branch", at: "2026-11-10T01:00:00Z", actor: "art" });
    const got: any = restored.collectionChanges({ "tasks/task": { rev: old.head, txn: old.txn } });
    expect(got["tasks/task"]).toEqual({ reset: true });
    expect(restored.collectionChanges({ "tasks/task": { rev: 0, txn: "another-origin" } })).toEqual({ "tasks/task": { reset: true } });
    restored.close();
  });
});
