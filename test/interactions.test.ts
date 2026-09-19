// Tests for ac-boundary-passive-history: interactions.jsonl written by SqliteStore.
// Every successful mutation must append a record; failures and no-op idempotent
// hits must not.

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/sqlite-store.js";

const AT = "2026-09-19T05:00:00.000Z";
const ACTOR = "test";

interface InteractionRecord {
  at: string;
  actor: string;
  op: string;
  task_id: string | null;
  diff: Record<string, { old: unknown; new: unknown }>;
}

let dir: string;
let dbPath: string;
let interactionsPath: string;
let store: SqliteStore;

function readInteractions(): InteractionRecord[] {
  if (!existsSync(interactionsPath)) return [];
  return readFileSync(interactionsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as InteractionRecord);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taskstore-int-"));
  dbPath = join(dir, "store.db");
  interactionsPath = dbPath.replace(/\.db$/, "") + ".interactions.jsonl";
  store = new SqliteStore(dbPath);
});

describe("ac-boundary-passive-history — file creation and envelope", () => {
  it("no interactions.jsonl before first mutation", () => {
    expect(existsSync(interactionsPath)).toBe(false);
  });

  it("interactions.jsonl created on first successful mutation", () => {
    store.run({ op: "create", title: "first", actor: ACTOR, at: AT });
    expect(existsSync(interactionsPath)).toBe(true);
  });

  it("each line is a valid JSON object with at/actor/op/task_id/diff", () => {
    store.run({ op: "create", title: "task one", actor: ACTOR, at: AT });
    const entries = readInteractions();
    expect(entries.length).toBe(1);
    const e = entries[0];
    expect(typeof e.at).toBe("string");
    expect(typeof e.actor).toBe("string");
    expect(typeof e.op).toBe("string");
    expect(e.task_id !== undefined).toBe(true); // string or null
    expect(typeof e.diff).toBe("object");
  });

  it("failed command does not append an entry", () => {
    const result = store.run({ op: "claim", id: "t-nonexistent", actor: ACTOR, at: AT });
    expect(result.ok).toBe(false);
    expect(existsSync(interactionsPath)).toBe(false);
  });
});

describe("ac-boundary-passive-history — create", () => {
  it("create appends one entry with task_id and diff including status and title", () => {
    const result = store.run({ op: "create", title: "my task", actor: ACTOR, at: AT });
    expect(result.ok).toBe(true);
    const entries = readInteractions();
    expect(entries.length).toBe(1);
    const e = entries[0];
    expect(e.op).toBe("create");
    expect(e.task_id).toBe(result.id);
    expect(e.actor).toBe(ACTOR);
    expect(e.at).toBe(AT);
    expect(e.diff.status?.new).toBe("open");
    expect(e.diff.title?.new).toBe("my task");
  });

  it("idempotent create (linkage collision) does NOT append an entry", () => {
    store.run({ op: "create", title: "spec task", actor: ACTOR, at: AT, specItemRef: "spec/x", criterionId: "ac-1" });
    const countBefore = readInteractions().length;
    const r2 = store.run({ op: "create", title: "spec task again", actor: ACTOR, at: AT, specItemRef: "spec/x", criterionId: "ac-1" });
    expect(r2.created).toBe(false);
    expect(readInteractions().length).toBe(countBefore); // no new entry
  });
});

describe("ac-boundary-passive-history — lifecycle ops", () => {
  let taskId: string;

  beforeEach(() => {
    const r = store.run({ op: "create", title: "lifecycle task", actor: ACTOR, at: AT });
    taskId = r.id as string;
  });

  it("claim appends entry with status diff open→in_progress", () => {
    store.run({ op: "claim", id: taskId, actor: ACTOR, at: AT });
    const entries = readInteractions();
    const claim = entries.find((e) => e.op === "claim")!;
    expect(claim).toBeDefined();
    expect(claim.task_id).toBe(taskId);
    expect(claim.diff.status).toEqual({ old: "open", new: "in_progress" });
    expect(claim.diff.assignee?.new).toBe(ACTOR);
  });

  it("unclaim appends entry with status diff in_progress→open", () => {
    store.run({ op: "claim", id: taskId, actor: ACTOR, at: AT });
    store.run({ op: "unclaim", id: taskId, actor: ACTOR, at: AT });
    const entries = readInteractions();
    const unclaim = entries.find((e) => e.op === "unclaim")!;
    expect(unclaim.diff.status).toEqual({ old: "in_progress", new: "open" });
  });

  it("close appends entry with status diff and closedAt", () => {
    store.run({ op: "close", id: taskId, actor: ACTOR, at: AT });
    const entries = readInteractions();
    const close = entries.find((e) => e.op === "close")!;
    expect(close.diff.status).toEqual({ old: "open", new: "closed" });
    expect(close.diff.closedAt?.new).toBe(AT);
  });

  it("reopen appends entry with status diff closed→open", () => {
    store.run({ op: "close", id: taskId, actor: ACTOR, at: AT });
    store.run({ op: "reopen", id: taskId, actor: ACTOR, at: AT });
    const entries = readInteractions();
    const reopen = entries.find((e) => e.op === "reopen")!;
    expect(reopen.diff.status).toEqual({ old: "closed", new: "open" });
    expect(reopen.diff.closedAt?.new).toBeNull();
  });

  it("delete appends entry with empty diff", () => {
    store.run({ op: "delete", id: taskId, actor: ACTOR, at: AT });
    const entries = readInteractions();
    const del = entries.find((e) => e.op === "delete")!;
    expect(del.task_id).toBe(taskId);
    expect(del.diff).toEqual({});
  });
});

describe("ac-boundary-passive-history — update and comment", () => {
  let taskId: string;

  beforeEach(() => {
    const r = store.run({ op: "create", title: "annotate me", actor: ACTOR, at: AT });
    taskId = r.id as string;
  });

  it("update appends entry with diff for changed fields only", () => {
    store.run({ op: "update", id: taskId, set: { title: "new title", priority: 1 }, actor: ACTOR, at: AT });
    const entries = readInteractions();
    const upd = entries.find((e) => e.op === "update")!;
    expect(upd.task_id).toBe(taskId);
    expect(upd.diff.title).toEqual({ old: "annotate me", new: "new title" });
    expect(upd.diff.priority).toEqual({ old: 2, new: 1 });
    expect(Object.keys(upd.diff)).not.toContain("status"); // unchanged field excluded
  });

  it("comment appends entry with new comment in diff", () => {
    store.run({ op: "comment", id: taskId, text: "hello world", actor: ACTOR, at: AT });
    const entries = readInteractions();
    const com = entries.find((e) => e.op === "comment")!;
    expect(com.task_id).toBe(taskId);
    expect(com.diff.comment?.old).toBeNull();
    expect((com.diff.comment?.new as { text: string }).text).toBe("hello world");
  });
});

describe("ac-boundary-passive-history — link and unlink", () => {
  let t1: string;
  let t2: string;

  beforeEach(() => {
    t1 = store.run({ op: "create", title: "a", actor: ACTOR, at: AT }).id as string;
    t2 = store.run({ op: "create", title: "b", actor: ACTOR, at: AT }).id as string;
  });

  it("link appends entry with edge in diff", () => {
    store.run({ op: "link", id: t1, dependsOn: t2, type: "blocks", actor: ACTOR, at: AT });
    const entries = readInteractions();
    const lnk = entries.find((e) => e.op === "link")!;
    expect(lnk.task_id).toBe(t1);
    expect(lnk.diff.link?.old).toBeNull();
    expect((lnk.diff.link?.new as { type: string }).type).toBe("blocks");
  });

  it("duplicate link (linked:false) does NOT append an entry", () => {
    store.run({ op: "link", id: t1, dependsOn: t2, type: "blocks", actor: ACTOR, at: AT });
    const countBefore = readInteractions().length;
    const r2 = store.run({ op: "link", id: t1, dependsOn: t2, type: "blocks", actor: ACTOR, at: AT });
    expect(r2.linked).toBe(false);
    expect(readInteractions().length).toBe(countBefore);
  });

  it("unlink that removes an edge appends entry with edge in diff", () => {
    store.run({ op: "link", id: t1, dependsOn: t2, type: "blocks", actor: ACTOR, at: AT });
    store.run({ op: "unlink", id: t1, dependsOn: t2, type: "blocks", actor: ACTOR, at: AT });
    const entries = readInteractions();
    const unl = entries.find((e) => e.op === "unlink")!;
    expect(unl.task_id).toBe(t1);
    expect(unl.diff.link?.new).toBeNull();
    expect((unl.diff.link?.old as { type: string }).type).toBe("blocks");
  });

  it("unlink that removes nothing (removed:false) does NOT append an entry", () => {
    const countBefore = readInteractions().length;
    const r = store.run({ op: "unlink", id: t1, dependsOn: t2, type: "blocks", actor: ACTOR, at: AT });
    expect(r.removed).toBe(false);
    expect(readInteractions().length).toBe(countBefore);
  });
});

describe("ac-boundary-passive-history — import", () => {
  it("import appends one entry per imported task", () => {
    const tasks = [
      { id: "legacy-1", title: "imported a", type: "task", status: "open", priority: 2, createdAt: AT, createdBy: ACTOR, comments: [] },
      { id: "legacy-2", title: "imported b", type: "task", status: "open", priority: 1, createdAt: AT, createdBy: ACTOR, comments: [] },
    ];
    const result = store.run({ op: "import", tasks, actor: ACTOR, at: AT });
    expect(result.ok).toBe(true);
    expect(result.imported).toBe(2);
    const entries = readInteractions();
    const imports = entries.filter((e) => e.op === "import");
    expect(imports.length).toBe(2);
    expect(imports.map((e) => e.task_id).sort()).toEqual(["legacy-1", "legacy-2"]);
  });
});

describe("ac-boundary-passive-history — append semantics", () => {
  it("multiple mutations accumulate in order", () => {
    store.run({ op: "create", title: "task", actor: ACTOR, at: AT });
    const id = readInteractions()[0].task_id!;
    store.run({ op: "claim", id, actor: ACTOR, at: AT });
    store.run({ op: "close", id, actor: ACTOR, at: AT });
    const entries = readInteractions();
    expect(entries.map((e) => e.op)).toEqual(["create", "claim", "close"]);
  });

  it("existing entries survive after a new mutation", () => {
    store.run({ op: "create", title: "first", actor: ACTOR, at: AT });
    store.run({ op: "create", title: "second", actor: ACTOR, at: AT });
    const entries = readInteractions();
    expect(entries.length).toBe(2);
    expect(entries[0].diff.title?.new).toBe("first");
    expect(entries[1].diff.title?.new).toBe("second");
  });
});
