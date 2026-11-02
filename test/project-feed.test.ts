// taskstore's project section feed (src/project-feed.ts) for loom's project
// hub (loom docs/specs/projects.md, "Section feeds" and "The tasks piece's
// side"): the four groups over the epic's tree, tasks outside it that name the
// project, digest ids in the body, loom's output caps; and the CLI verb.
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, emptyState, type Command, type StoreState } from "../src/core.js";
import { bodyOf, feed, namesProject, parseFeedArgs, treeOf, MAX_ITEMS, OUTSIDE, type Feed, type FeedArgs, type FeedView } from "../src/project-feed.js";

const AT = "2026-10-30T12:00:00Z";
const SINCE = "2026-10-26T15:00:00Z";

function state(ops: Array<Record<string, unknown>>): StoreState {
  let s = emptyState();
  for (const op of ops) {
    const r = apply(s, { actor: "art", at: AT, ...op } as Command);
    if (r.result.ok !== true) throw new Error(`${JSON.stringify(op)} -> ${JSON.stringify(r.result)}`);
    s = r.state;
  }
  return s;
}
function view(s: StoreState, owner = "jonathan"): FeedView {
  return { tasks: s.tasks, links: s.links, ready: apply(s, { op: "ready" }).result.entries as FeedView["ready"], owner };
}
const args = (extra: Partial<FeedArgs> = {}): FeedArgs => ({ project: "pond", since: SINCE, epic: "t-1", names: ["on-pond"], venues: [], ...extra });

/** loom's output schema (src/offers.ts parseFeed): what loom accepts, checked here so the feed never fails there. */
function loomAccepts(f: Feed): string | undefined {
  const known = (o: object, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
  if (!known(f, ["groups"]) || f.groups.length > 8) return "groups";
  if (f.groups.reduce((n, g) => n + g.items.length, 0) > 50) return "items";
  for (const g of f.groups) {
    if (!known(g, ["title", "items"]) || !g.title || g.title.length > 80) return `group ${g.title}`;
    for (const i of g.items) {
      if (!known(i, ["title", "when", "who", "person", "status", "ref", "body"])) return "item keys";
      if (!i.title || i.title.length > 200) return "title";
      if (i.when !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(i.when)) return `when ${i.when}`;
      if (i.status !== undefined && (!i.status || i.status.length > 24)) return `status ${i.status}`;
      if (i.ref !== undefined && (!i.ref || i.ref.length > 200)) return "ref";
      if (i.body !== undefined && (!i.body || i.body.length > 600)) return "body";
    }
  }
  return undefined;
}

// t-1 the epic. Its tree: t-2 (ready), t-3 (the owner's), t-4 (blocked by t-9),
// t-5 (a child of t-2: grandchild, ready), t-6 (closed in the window), t-7
// (closed before it), t-8 (in progress, the agent's). Outside it: t-9 (names
// "pond", ready), t-10 (names alias "on-pond", the owner's), t-11 (names
// "ponder": no match), t-12 (closed, names pond: not matched, outside is open
// only), t-13 (another epic's child, names nothing).
const base = () => state([
  { op: "create", title: "Pond rebuild", type: "epic", priority: 1 },
  { op: "create", title: "cut over the DNS", priority: 2, parent: "t-1", description: "From the conversation, dg-0123456789ab." },
  { op: "create", title: "approve the WAF exception", priority: 1, parent: "t-1" },
  { op: "create", title: "move the sites", priority: 2, parent: "t-1" },
  { op: "create", title: "the first site", priority: 0, parent: "t-2" },
  { op: "create", title: "dev soak", priority: 2, parent: "t-1", at: "2026-10-20T00:00:00Z" },
  { op: "create", title: "old thing", priority: 2, parent: "t-1", at: "2026-10-01T00:00:00Z" },
  { op: "create", title: "being done", priority: 2, parent: "t-1" },
  { op: "create", title: "fix the pond WAF rule", priority: 1 },
  { op: "create", title: "ask about it", priority: 3, description: "for on-pond" },
  { op: "create", title: "ponder things", priority: 2 },
  { op: "create", title: "pond, closed", priority: 2 },
  { op: "create", title: "elsewhere", priority: 2 },
  { op: "update", id: "t-3", set: { assignee: "jonathan" } },
  { op: "update", id: "t-10", set: { assignee: "jonathan" } },
  { op: "link", id: "t-4", dependsOn: "t-9", type: "blocks" },
  { op: "close", id: "t-6", at: "2026-10-29T08:00:00Z" },
  { op: "close", id: "t-7", at: "2026-10-02T00:00:00Z" },
  { op: "close", id: "t-12" },
  { op: "claim", id: "t-8" },
  { op: "comment", id: "t-3", text: "nudged", at: "2026-10-31T09:00:00Z" },
]);

describe("project feed", () => {
  it("the epic's tree in four groups, plus open tasks outside it that name the project", () => {
    const f = feed(view(base()), args());
    expect(loomAccepts(f)).toBeUndefined();
    expect(f.groups.map((g) => g.title)).toEqual(["Waiting on you", "Ready", "Blocked", "Done"]);
    const [waiting, ready, blocked, done] = f.groups;
    expect(waiting.items).toEqual([
      { title: "approve the WAF exception", when: "2026-10-31T09:00:00.000Z", status: "open", ref: "t-3" },
      { title: "ask about it", when: "2026-10-30T12:00:00.000Z", status: OUTSIDE, ref: "t-10", body: "for on-pond" },
    ]);
    expect(ready.items.map((i) => [i.ref, i.status])).toEqual([["t-5", "ready"], ["t-9", OUTSIDE], ["t-2", "ready"]]);
    expect(ready.items[2].body).toBe("From the conversation, dg-0123456789ab.");
    expect(blocked.items).toEqual([{ title: "move the sites", when: "2026-10-30T12:00:00.000Z", status: "blocked by t-9", ref: "t-4" }]);
    expect(done.items).toEqual([{ title: "dev soak", when: "2026-10-29T08:00:00.000Z", status: "done", ref: "t-6" }]);
    // Not anywhere: the epic itself, the in-progress t-8, "ponder", a closed outside task, another tree's task.
    const refs = f.groups.flatMap((g) => g.items.map((i) => i.ref));
    for (const id of ["t-1", "t-7", "t-8", "t-11", "t-12", "t-13"]) expect(refs).not.toContain(id);
  });

  it("without an epic only the tasks that name the project; without an owner nothing is waiting", () => {
    const f = feed(view(base(), ""), args({ epic: undefined }));
    expect(f.groups.map((g) => [g.title, g.items.map((i) => i.ref)])).toEqual([["Ready", ["t-9", "t-10"]]]);
    expect(f.groups[0].items.every((i) => i.status === OUTSIDE)).toBe(true);
  });

  it("nothing for the project is {groups: []}", () => {
    expect(feed(view(base()), args({ project: "hockey", epic: "t-404", names: [] }))).toEqual({ groups: [] });
  });

  it("a task the owner holds is waiting on them, even when blocked; a done task's when is when it closed", () => {
    const s = state([
      { op: "create", title: "epic", type: "epic" },
      { op: "create", title: "blocker", parent: "t-1" },
      { op: "create", title: "theirs, blocked", parent: "t-1" },
      { op: "update", id: "t-3", set: { assignee: "jonathan" } },
      { op: "link", id: "t-3", dependsOn: "t-2", type: "blocks" },
      { op: "close", id: "t-2", at: "2026-10-31T00:00:00Z", reason: "cancelled" },
    ]);
    const f = feed(view(s), args());
    expect(f.groups.map((g) => [g.title, g.items.map((i) => [i.ref, i.status, i.when])])).toEqual([
      ["Waiting on you", [["t-3", "open", "2026-10-30T12:00:00.000Z"]]],
      ["Done", [["t-2", "cancelled", "2026-10-31T00:00:00.000Z"]]],
    ]);
  });

  it("at most 50 items in all, shared out fairly, a cut group saying so; every string within loom's caps", () => {
    const ops: Array<Record<string, unknown>> = [{ op: "create", title: "epic", type: "epic" }];
    // 60 ready, 3 owner's, 40 done: ready and done share what the owner's leave.
    for (let i = 0; i < 60; i++) ops.push({ op: "create", title: `ready ${i} ${"x".repeat(300)}`, parent: "t-1", description: "d".repeat(2000) });
    for (let i = 0; i < 3; i++) ops.push({ op: "create", title: `theirs ${i}`, parent: "t-1" });
    for (let i = 0; i < 40; i++) ops.push({ op: "create", title: `done ${i}`, parent: "t-1" });
    for (let i = 0; i < 3; i++) ops.push({ op: "update", id: `t-${62 + i}`, set: { assignee: "jonathan" } });
    for (let i = 0; i < 40; i++) ops.push({ op: "close", id: `t-${65 + i}` });
    const f = feed(view(state(ops)), args({ names: [] }));
    expect(loomAccepts(f)).toBeUndefined();
    expect(f.groups.map((g) => [g.title, g.items.length])).toEqual([["Waiting on you", 3], ["Ready (24 of 60)", 24], ["Done (23 of 40)", 23]]);
    expect(f.groups.reduce((n, g) => n + g.items.length, 0)).toBe(MAX_ITEMS);
    expect(f.groups[1].items[0].title).toHaveLength(200);
    expect(f.groups[1].items[0].body).toHaveLength(600);
  });

  it("a long description keeps the digest ids it cites within 600", () => {
    const d = `${"word ".repeat(200)}see dg-aaaaaaaaaaaa and dg-bbbbbbbbbbbb`;
    const b = bodyOf(d)!;
    expect(b.length).toBeLessThanOrEqual(600);
    expect(b).toMatch(/…\ndg-aaaaaaaaaaaa dg-bbbbbbbbbbbb$/);
    expect(bodyOf("short dg-cccccccccccc")).toBe("short dg-cccccccccccc");
    expect(bodyOf("  ")).toBeUndefined();
  });

  it("names match as whole words, any case; the tree follows parent-child links all the way down", () => {
    expect(namesProject("Fix the Pond WAF", ["pond"])).toBe(true);
    expect(namesProject("ponder", ["pond"])).toBe(false);
    expect(namesProject("on-pond work", ["pond"])).toBe(false);
    expect(namesProject("on-pond work", ["pond", "on-pond"])).toBe(true);
    expect(namesProject("(pond)", ["pond"])).toBe(true);
    expect([...treeOf(base().links, "t-1")].sort()).toEqual(["t-2", "t-3", "t-4", "t-5", "t-6", "t-7", "t-8"]);
    expect(treeOf(base().links, undefined).size).toBe(0);
  });

  it("parses its arguments: --name and --venue repeat; --project and --since are required", () => {
    expect(parseFeedArgs(["--json", "--project", "pond", "--since", SINCE, "--epic", "t-1", "--name", "a", "--name", "b", "--venue", "slack:C1", "--venue", "x"]))
      .toEqual({ project: "pond", since: SINCE, epic: "t-1", names: ["a", "b"], venues: ["slack:C1", "x"] });
    expect(parseFeedArgs(["--since", SINCE])).toMatch(/--project is required/);
    expect(parseFeedArgs(["--project", "pond"])).toMatch(/--since is required/);
    expect(parseFeedArgs(["--project", "pond", "--since", "tuesday"])).toMatch(/ISO-8601/);
    expect(parseFeedArgs(["--project", "pond", "--since", SINCE, "--unfiled"])).toMatch(/unknown argument "--unfiled"/);
    expect(parseFeedArgs(["--project", "--since", SINCE])).toMatch(/--project needs a value/);
  });
});

describe("taskstore project-feed (the CLI verb)", () => {
  const repo = join(__dirname, "..");
  const cli = join(repo, "dist", "cli.js");
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TASKSTORE_")));
  let db = "";
  const run = (a: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [cli, ...a], { encoding: "utf8", env: { ...baseEnv, TASKSTORE_DB: db, ...extra } });

  beforeAll(() => {
    spawnSync("npm", ["run", "build"], { cwd: repo, stdio: "pipe" });
    db = join(mkdtempSync(join(tmpdir(), "taskstore-feed-")), "store.db");
    for (const a of [
      ["create", "Pond", "--type", "epic"],
      ["create", "cut over", "--parent", "t-1", "--description", "dg-0123456789ab"],
      ["create", "yours", "--parent", "t-1"], ["update", "t-3", "--assignee", "jonathan"],
      ["create", "the toad thing"],
    ]) expect(run(a).status).toBe(0);
  }, 60000);

  it("answers loom's argv with one JSON object, and writes nothing", () => {
    const before = readFileSync(db);
    const r = run(["project-feed", "--json", "--project", "pond", "--since", SINCE, "--epic", "t-1", "--name", "toad", "--venue", "slack:C0POND"], { TASKSTORE_OWNER: "jonathan" });
    expect(r.status, r.stderr).toBe(0);
    const f = JSON.parse(r.stdout) as Feed;
    expect(loomAccepts(f)).toBeUndefined();
    expect(f.groups.map((g) => [g.title, g.items.map((i) => [i.ref, i.status, i.body])])).toEqual([
      ["Waiting on you", [["t-3", "open", undefined]]],
      ["Ready", [["t-2", "ready", "dg-0123456789ab"], ["t-4", OUTSIDE, undefined]]],
    ]);
    expect(readFileSync(db).equals(before)).toBe(true);
  });

  it("a usage error is exit 2; no store is exit 1", () => {
    expect(run(["project-feed", "--json", "--since", SINCE]).status).toBe(2);
    const r = spawnSync(process.execPath, [cli, "project-feed", "--json", "--project", "pond", "--since", SINCE], {
      encoding: "utf8", cwd: mkdtempSync(join(tmpdir(), "taskstore-feed-")), env: baseEnv,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no store at/);
  });

  it("package.json declares the feed for loom, with its own bin", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    expect(pkg.loom.sections).toEqual({ project: { label: "Tasks", argv: ["loom-tasks", "project-feed", "--json"] } });
    expect(Object.keys(pkg.bin)).toContain("loom-tasks");
  });
});
