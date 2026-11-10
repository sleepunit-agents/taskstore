// The tasks role's shared collection (src/collections.ts; loom docs/specs/collections.md, t-2029). Pinned:
//  - the declaration loom installs (package.json loom.collections) is the module's own;
//  - the records are the store's tasks, whole: every task once across keyset pages, in order, filtered as asked;
//  - parity: the open queue is `list`'s, and a thread's made-here tasks are the thread feed's;
//  - the viewer: loom and household owners get rows; an agent's token, an owner of some agents, nobody else does;
//  - a row carries only the fields asked for, the order's, its id and its audience; the CLI answers the same lines.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, emptyState, type Command, type StoreState } from "../src/core.js";
import { answer, TASK_TYPE, type Batch, type ProviderQuery } from "../src/collections.js";
import { threadFeed } from "../src/thread-feed.js";

const CV = "cv-0123456789ab";
const at = (m: number) => `2026-11-05T12:${String(m).padStart(2, "0")}:00Z`;

function state(ops: Array<Record<string, unknown>>): StoreState {
  let s = emptyState();
  ops.forEach((op, i) => {
    const r = apply(s, { actor: "art", at: at(i), ...op } as Command);
    if (r.result.ok !== true) throw new Error(`${JSON.stringify(op)} -> ${JSON.stringify(r.result)}`);
    s = r.state;
  });
  return s;
}

const s = state([
  { op: "create", title: "Epic", type: "epic" },                                  // t-1
  { op: "create", title: "Child, made in the thread", source: `conversation:${CV}`, priority: 1 }, // t-2
  { op: "link", id: "t-2", dependsOn: "t-1", type: "parent-child" },
  { op: "create", title: "Started", priority: 0 },                               // t-3
  { op: "claim", id: "t-3" },
  { op: "create", title: "Closed", priority: 3 },                                // t-4
  { op: "close", id: "t-4" },
  { op: "create", title: "Commented", description: "A long body", priority: 2 },  // t-5
  { op: "comment", id: "t-5", text: "later" },
  { op: "create", title: "Yours", source: `conversation:${CV}`, priority: 2 },    // t-6
  { op: "update", id: "t-6", set: { assignee: "jonathan", ask: "Is it right?" } },
]);

const OWNER = { kind: "member", household: true };
const q = (o: Partial<ProviderQuery> = {}): ProviderQuery => ({ id: "q", type: "task", version: 1, where: [], order: [], limit: 500, after: null, fields: [...TASK_TYPE.default_fields], ...o });
const run = (batch: Batch) => answer(batch, s.tasks, s.links).map((l) => JSON.parse(l) as Record<string, unknown>);
const rows = (batch: Batch) => run(batch).filter((l) => l.row).map((l) => l.row as Record<string, unknown>);

describe("the tasks collection", () => {
  it("declares in package.json exactly what the module answers", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { loom: { collections: Record<string, unknown> } };
    expect(pkg.loom.collections).toEqual({ query: ["loom-tasks", "collections", "query", "--json"], types: { task: JSON.parse(JSON.stringify(TASK_TYPE)) } });
  });

  it("answers every task once, whole, across keyset pages in order", () => {
    const order: ProviderQuery["order"] = [["priority", "asc"], ["updated", "desc"]];
    const seen: string[] = [];
    let after: unknown[] | null = null;
    for (let i = 0; i < 10; i++) {
      const lines = run({ viewer: OWNER, queries: [q({ order, limit: 2, after })] });
      const page = lines.filter((l) => l.row).map((l) => l.row as Record<string, unknown>);
      seen.push(...page.map((r) => r.id as string));
      const more = lines.find((l) => "more" in l)!.more;
      if (!more) break;
      const last = page.at(-1)!;
      after = [last.priority, last.updated, last.id];
    }
    expect(seen.sort()).toEqual(s.tasks.map((t) => t.id).sort());
    const all = rows({ viewer: OWNER, queries: [q({ order })] });
    expect(all.map((r) => r.priority)).toEqual([...all.map((r) => r.priority as number)].sort((a, b) => a - b));
    const t5 = all.find((r) => r.id === "t-5")!;
    // Its newest time is its comment's; its parent is the link's.
    expect(t5.updated).toBe(s.tasks.find((t) => t.id === "t-5")!.comments[0].at);
    expect(rows({ viewer: OWNER, queries: [q({ where: [["parent", "eq", "t-1"]], fields: ["parent"] })] }).map((r) => r.id)).toEqual(["t-2"]);
  });

  it("parity: the open queue is list's, and a thread's tasks made there are the thread feed's", () => {
    const open = rows({ viewer: OWNER, queries: [q({ where: [["status", "in", ["open", "in_progress"]]] })] }).map((r) => r.id).sort();
    expect(open).toEqual(s.tasks.filter((t) => t.status !== "closed").map((t) => t.id).sort());
    const made = rows({ viewer: OWNER, queries: [q({ where: [["source", "eq", `conversation:${CV}`]] })] }).map((r) => r.id).sort();
    const f = threadFeed({ tasks: s.tasks, links: s.links, owner: "jonathan" }, { conversation: CV, refs: [] });
    const fed = JSON.stringify(f);
    for (const id of made) expect(fed).toContain(id);
    expect(made).toEqual(s.tasks.filter((t) => t.source === `conversation:${CV}`).map((t) => t.id).sort());
    const asks = rows({ viewer: OWNER, queries: [q({ where: [["ask", "has"]], fields: ["ask", "assignee"] })] });
    expect(asks).toEqual([{ id: "t-6", ask: "Is it right?", assignee: "jonathan", audience: { owners: true } }]);
  });

  it("answers loom and household owners, and no one else, before it pages", () => {
    expect(rows({ viewer: { kind: "core" }, queries: [q()] })).toHaveLength(s.tasks.length);
    for (const viewer of [{ kind: "agent" }, { kind: "member", household: false }, undefined]) {
      const lines = run({ viewer: viewer as Batch["viewer"], queries: [q({ limit: 2 })] });
      expect(lines).toEqual([{ id: "q", more: false }]);
    }
  });

  it("sends only the fields asked for, the order's, its id and audience; a heavy one only by name", () => {
    const [r] = rows({ viewer: OWNER, queries: [q({ where: [["status", "eq", "closed"]], fields: ["title"], order: [["created", "asc"]] })] });
    expect(r).toEqual({ id: "t-4", title: "Closed", created: s.tasks.find((t) => t.id === "t-4")!.createdAt, audience: { owners: true } });
    expect(rows({ viewer: OWNER, queries: [q({ where: [["status", "eq", "closed"]] })] })[0]).not.toHaveProperty("description");
    expect(rows({ viewer: OWNER, queries: [q({ where: [["priority", "eq", 2], ["assignee", "eq", null]], fields: ["description"] })] }).find((r) => r.id === "t-5")!.description).toBe("A long body");
    expect(run({ viewer: OWNER, queries: [q({ type: "nope" }), q({ id: "v2", version: 2 })] })).toEqual([{ id: "q", error: "unsupported-version" }, { id: "v2", error: "unsupported-version" }]);
  });

  it("the CLI answers loom's batch as JSON lines, and unavailable with no store", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskstore-collections-"));
    const db = join(dir, "store.db");
    const cli = join(new URL("..", import.meta.url).pathname, "src", "cli.ts");
    const tsx = join(new URL("..", import.meta.url).pathname, "node_modules", ".bin", "tsx");
    const env = { ...process.env, TASKSTORE_DB: db, TASKSTORE_ACTOR: "art" };
    const batch = JSON.stringify({ viewer: OWNER, queries: [q({ fields: ["title"] })] });
    const none = spawnSync(tsx, [cli, "collections", "query", "--json"], { env, input: batch, encoding: "utf8" });
    expect(none.status).toBe(0);
    expect(none.stdout.trim()).toBe(JSON.stringify({ id: "q", error: "unavailable" }));
    expect(spawnSync(tsx, [cli, "create", "Made by the CLI"], { env, encoding: "utf8" }).status).toBe(0);
    const got = spawnSync(tsx, [cli, "collections", "query", "--json"], { env, input: batch, encoding: "utf8" });
    expect(got.status).toBe(0);
    const lines = got.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([{ id: "q", row: { id: "t-1", title: "Made by the CLI", audience: { owners: true } } }, { id: "q", more: false }]);
  });
});
