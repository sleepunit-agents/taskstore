// taskstore as loom's tasks piece: page contract v2 (loom docs/extensions.md,
// "The page"): `ui --json` manifest, `ui page --json`, `ui act --json`.
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, emptyState, type Command, type StoreState, type Task } from "../src/core.js";
import { checkAct, humanDate, manifest, page, NOT_FOUND, type UiView } from "../src/loom-ui.js";

const AT = "2026-10-24T17:09:00Z";

/** Fold ops through the real core, so the view is one the store could hold. */
function state(ops: Array<Record<string, unknown>>): StoreState {
  let s = emptyState();
  for (const op of ops) {
    const r = apply(s, { actor: "art", at: AT, ...op } as Command);
    if (r.result.ok !== true) throw new Error(`${JSON.stringify(op)} -> ${JSON.stringify(r.result)}`);
    s = r.state;
  }
  return s;
}

function view(s: StoreState, owner = "jonathan"): UiView {
  const ready = apply(s, { op: "ready" }).result.entries as UiView["ready"];
  return { tasks: s.tasks, links: s.links, ready, owner, now: new Date("2026-10-24T20:00:00Z"), timeZone: "America/Chicago" };
}

type Blk = { type: string; items?: Array<Record<string, unknown>>; text?: string; [k: string]: unknown };
const section = (p: ReturnType<typeof page>, id: string) => p.sections.find((s) => s.id === id);
const block = (p: ReturnType<typeof page>, id: string, type: string) =>
  section(p, id)?.blocks.find((b) => b.type === type) as Blk | undefined;

// t-1 p1 in progress (art); t-2 p0 ready; t-3 p3 open, the owner's;
// t-4 p2 in progress, the owner's; t-5 p1 closed, the owner's (not an ask);
// t-6 p2 open, blocked by t-1; t-7 epic p1 (never ready).
const base = () => state([
  { op: "create", title: "doing one", priority: 1, description: "Why and how." },
  { op: "create", title: "urgent ready", priority: 0 },
  { op: "create", title: "pick the key recovery", priority: 3 },
  { op: "create", title: "owner doing", priority: 2 },
  { op: "create", title: "owner closed", priority: 1 },
  { op: "create", title: "blocked", priority: 2 },
  { op: "create", title: "an epic", priority: 1, type: "epic" },
  { op: "claim", id: "t-1" },
  { op: "update", id: "t-3", set: { assignee: "jonathan" } },
  { op: "claim", id: "t-4", actor: "jonathan" },
  { op: "update", id: "t-5", set: { assignee: "jonathan" } },
  { op: "close", id: "t-5" },
  { op: "link", id: "t-6", dependsOn: "t-1", type: "blocks" },
  { op: "link", id: "t-6", dependsOn: "t-7", type: "parent-child" },
  { op: "comment", id: "t-6", text: "first note", at: "2026-10-24T17:30:00Z" },
]);

describe("manifest", () => {
  it("has the tab, the Work tile and the owner's open asks, highest priority first", () => {
    const m = manifest(view(base()));
    expect(m.v).toBe(2);
    expect(m.tab).toEqual({ label: "Tasks" });
    expect(m.tile).toEqual({ label: "Work", value: "2 in progress", detail: "1 ready at p0–p1", tone: "warn", page: "" });
    expect(m.asks).toEqual([
      { text: "owner doing", meta: "t-4 · p2", page: "task/t-4", label: "Decide" },
      { text: "pick the key recovery", meta: "t-3 · p3", page: "task/t-3", label: "Decide" },
    ]);
  });

  it("has no warn tone when nothing at p0–p1 is ready, and honours another owner", () => {
    const m = manifest(view(state([{ op: "create", title: "x", priority: 2 }, { op: "update", id: "t-1", set: { assignee: "gage" } }]), "gage"));
    expect(m.tile).toEqual({ label: "Work", value: "0 in progress", detail: "0 ready at p0–p1", page: "" });
    expect(m.asks.map((a) => a.meta)).toEqual(["t-1 · p2"]);
  });

  it("caps asks at 10", () => {
    const ops = Array.from({ length: 12 }, () => ({ op: "create", title: "x" }));
    const s = state([...ops, ...ops.map((_, i) => ({ op: "update", id: `t-${i + 1}`, set: { assignee: "jonathan" } }))]);
    expect(manifest(view(s)).asks).toHaveLength(10);
  });
});

describe("Work page", () => {
  it("has Your call (warn), stats, a priority filter, and linked lists with counts", () => {
    const p = page(view(base()), { path: "", query: {} });
    expect(p.title).toBe("Work");
    expect(p.sections.map((s) => s.id)).toEqual(["yours", "summary", "in-progress", "ready"]);
    expect(section(p, "yours")).toMatchObject({ title: "Your call", tone: "warn" });
    expect(block(p, "yours", "list")!.items!.map((i) => i.page)).toEqual(["task/t-4", "task/t-3"]);
    expect(block(p, "summary", "stats")!.items!.map((i) => i.value)).toEqual(["2", "2", "1"]);
    const f = block(p, "summary", "filters")!;
    expect(f.param).toBe("priority");
    expect(f.options).toEqual([
      { value: "", label: "All" }, { value: "0", label: "p0" }, { value: "1", label: "p1" },
      { value: "2", label: "p2" }, { value: "3", label: "p3" }, { value: "4", label: "p4" },
    ]);
    expect(block(p, "in-progress", "list")!.items).toEqual([
      { text: "doing one", meta: "t-1 · p1 · art", page: "task/t-1" },
      { text: "owner doing", meta: "t-4 · p2 · jonathan", page: "task/t-4" },
    ]);
    expect(block(p, "in-progress", "text")!.text).toBe("Shown 2 of 2.");
    expect(block(p, "ready", "list")!.items).toEqual([{ text: "urgent ready", meta: "t-2 · p0", page: "task/t-2" }]);
    expect(block(p, "ready", "text")!.text).toBe("Shown 1 of 1.");
  });

  it("filters both lists by priority, and ignores a bad filter value", () => {
    const p = page(view(base()), { path: "", query: { priority: "3" } });
    expect(section(p, "in-progress")!.title).toBe("In progress at p3");
    expect(block(p, "in-progress", "text")!.text).toBe("Nothing in progress at p3.");
    expect(block(p, "ready", "list")!.items!.map((i) => i.page)).toEqual(["task/t-3"]);
    const bad = page(view(base()), { path: "", query: { priority: "9" } });
    expect(section(bad, "ready")!.title).toBe("Ready at p0–p1");
  });

  it("drops Your call when nothing is the owner's, and shows N of M past the cap", () => {
    const s = state(Array.from({ length: 60 }, () => ({ op: "create", title: "x", priority: 1 })));
    const p = page(view(s), { path: "" });
    expect(section(p, "yours")).toBeUndefined();
    expect(block(p, "ready", "list")!.items).toHaveLength(50);
    expect(block(p, "ready", "text")!.text).toBe("Shown 50 of 60.");
  });
});

describe("task page", () => {
  it("has the record, description, history and a comment form", () => {
    const p = page(view(base()), { path: "task/t-6", query: {} });
    expect(p.title).toBe("blocked");
    expect(p.intro).toBe("t-6 · open (blocked) · p2");
    expect(block(p, "facts", "kv")!.items).toEqual([
      { label: "status", value: "open (blocked)" },
      { label: "priority", value: "p2" },
      { label: "assignee", value: "nobody" },
      { label: "opened", value: "Sat Oct 24, 12:09 pm by art" },
      { label: "parent", value: "t-7 an epic", page: "task/t-7" },
      { label: "depends on", value: "t-1 doing one", page: "task/t-1" },
    ]);
    expect(section(p, "facts")!.side).toBe(true);
    expect(block(p, "history", "list")!.items).toEqual([{ text: "first note", meta: "art · Sat Oct 24, 12:30 pm" }]);
    expect(block(p, "comment", "form")).toMatchObject({
      action: "comment", hidden: { id: "t-6" },
      fields: [{ name: "text", kind: "textarea", required: true }],
    });
    expect(block(p, "task", "link")).toEqual({ type: "link", text: "← Work", page: "" });
  });

  it("shows the description, started date, and a Your call callout on the owner's task", () => {
    const one = page(view(base()), { path: "task/t-1" });
    expect(block(one, "task", "text")!.text).toBe("Why and how.");
    expect(block(one, "facts", "kv")!.items).toContainEqual({ label: "started", value: "Sat Oct 24, 12:09 pm" });
    expect(block(one, "task", "callout")).toBeUndefined();
    const mine = page(view(base()), { path: "task/t-4" });
    expect(block(mine, "task", "callout")).toMatchObject({ title: "Your call", tone: "warn" });
  });

  it("answers Not found for an unknown id, an unknown path, and malformed requests", () => {
    const v = view(base());
    for (const req of [{ path: "task/t-999" }, { path: "nope" }, { path: "task/../t-1" }, { path: 7 }, null, "x", [], {}])
      expect(page(v, req)).toEqual(NOT_FOUND);
  });

  it("never emits a link a page path can't carry", () => {
    const s = state([{ op: "import", tasks: [{ id: "BD-1", title: "legacy", type: "task", status: "open", priority: 1, createdAt: AT, createdBy: "art", comments: [] }], links: [] }]);
    const m = manifest(view(s));
    const items = block(page(view(s), { path: "" }), "ready", "list")!.items!;
    expect(items[0]).toEqual({ text: "legacy", meta: "BD-1 · p1" });
    expect(m.tile.value).toBe("0 in progress");
  });

  it("keeps every string within the contract's 2000 characters", () => {
    const long = "y".repeat(5000);
    const s = state([{ op: "create", title: "t", description: long }, { op: "comment", id: "t-1", text: long }]);
    const p = page(view(s), { path: "task/t-1" });
    const texts = section(p, "task")!.blocks.filter((b) => b.type === "text").map((b) => b.text as string);
    expect(texts.join("")).toBe(long);
    expect(Math.max(...texts.map((t) => t.length))).toBeLessThanOrEqual(2000);
    expect((block(p, "history", "list")!.items![0].text as string).length).toBe(2000);
  });
});

describe("humanDate", () => {
  it("reads like 'Sat Oct 24, 12:09 pm' in the given zone, with the year when it isn't this one", () => {
    const now = new Date(AT);
    expect(humanDate(AT, now, "America/Chicago")).toBe("Sat Oct 24, 12:09 pm");
    expect(humanDate(AT, now, "UTC")).toBe("Sat Oct 24, 5:09 pm");
    expect(humanDate("2025-01-02T09:05:00Z", now, "UTC")).toBe("Thu Jan 2 2025, 9:05 am");
    expect(humanDate(AT, now, "Not/AZone")).toMatch(/^Sat Oct 24, \d+:09 [ap]m$/);
  });
});

describe("checkAct", () => {
  const v = view(base());
  it("accepts a comment on a real task, trimmed", () => {
    expect(checkAct(v, { action: "comment", path: "task/t-1", fields: { id: "t-1", text: "  go  " } })).toEqual({ ok: true, id: "t-1", text: "go" });
  });
  it("refuses everything else with a message", () => {
    for (const req of [
      null, "x", [],
      { action: "close", fields: { id: "t-1" } },
      { action: "comment", fields: { id: "t-999", text: "hi" } },
      { action: "comment", fields: { text: "hi" } },
      { action: "comment", fields: { id: "t-1", text: "   " } },
      { action: "comment", fields: { id: "t-1", text: 5 } },
      { action: "comment", fields: { id: "t-1", text: "z".repeat(10001) } },
      { action: "comment", fields: "nope" },
    ]) {
      const r = checkAct(v, req);
      expect(r.ok).toBe(false);
      expect((r as { message: string }).message).toMatch(/\w/);
    }
    expect(checkAct(v, { action: "comment", fields: { id: "t-1", text: "z".repeat(10000) } }).ok).toBe(true);
  });
});

describe("taskstore ui (the CLI verbs)", () => {
  const repo = join(__dirname, "..");
  const cli = join(repo, "dist", "cli.js");
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TASKSTORE_")));
  let db = "";
  const run = (args: string[], input = "", extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8", input, maxBuffer: 16 * 1024 * 1024,
      env: { ...baseEnv, TASKSTORE_DB: db, TZ: "America/Chicago", ...extra },
    });
  const json = (r: ReturnType<typeof run>) => {
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };

  beforeAll(() => {
    // Built dist, like cli-binding.test.ts: what the installed launcher runs.
    spawnSync("npm", ["run", "build"], { cwd: repo, stdio: "pipe" });
    db = join(mkdtempSync(join(tmpdir(), "taskstore-ui-")), "store.db");
    for (const args of [
      ["create", "doing", "--priority", "1"], ["claim", "t-1"],
      ["create", "yours", "--priority", "2"], ["update", "t-2", "--assignee", "jonathan"],
    ]) expect(run(args).status).toBe(0);
  }, 60000);

  it("refuses, and creates nothing, when there's no store", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskstore-ui-"));
    const r = spawnSync(process.execPath, [cli, "ui", "--json"], { cwd: dir, encoding: "utf8", env: baseEnv });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no store at/);
    expect(existsSync(join(dir, ".taskstore"))).toBe(false);
  });

  it("ui --json is the v2 manifest", () => {
    const m = json(run(["ui", "--json"]));
    expect(m).toMatchObject({ v: 2, tab: { label: "Tasks" }, tile: { value: "1 in progress", detail: "0 ready at p0–p1" } });
    expect(m.asks).toEqual([{ text: "yours", meta: "t-2 · p2", page: "task/t-2", label: "Decide" }]);
  });

  it("ui page --json answers both pages, and Not found for junk", () => {
    expect(json(run(["ui", "page", "--json"], JSON.stringify({ path: "", query: {} }))).title).toBe("Work");
    expect(json(run(["ui", "page", "--json"], JSON.stringify({ path: "task/t-1" }))).title).toBe("doing");
    for (const input of ["", "not json", "[]", JSON.stringify({ path: "task/t-404" })])
      expect(json(run(["ui", "page", "--json"], input))).toEqual({ title: "Not found", sections: [] });
  });

  it("ui act --json adds the comment as the owner through the core", () => {
    const r = json(run(["ui", "act", "--json"], JSON.stringify({ action: "comment", path: "task/t-1", fields: { id: "t-1", text: "Go with A." } }), { TASKSTORE_OWNER: "gage" }));
    expect(r).toEqual({ ok: true, message: "Comment added.", page: "task/t-1" });
    const shown = JSON.parse(run(["show", "t-1"]).stdout).task as Task;
    expect(shown.comments.at(-1)).toMatchObject({ actor: "gage", text: "Go with A." });
    const p = json(run(["ui", "page", "--json"], JSON.stringify({ path: "task/t-1" })));
    expect(p.sections.find((s: { id: string }) => s.id === "history").blocks[0].items[0].text).toBe("Go with A.");
  });

  it("ui act --json refuses with ok:false and exit 0, writing nothing", () => {
    const before = run(["show", "t-1"]).stdout;
    for (const input of ["", "{", JSON.stringify({ action: "delete", fields: { id: "t-1" } }),
      JSON.stringify({ action: "comment", fields: { id: "t-404", text: "x" } }),
      JSON.stringify({ action: "comment", fields: { id: "t-1", text: "" } })]) {
      const r = json(run(["ui", "act", "--json"], input));
      expect(r.ok).toBe(false);
      expect(typeof r.message).toBe("string");
    }
    expect(run(["show", "t-1"]).stdout).toBe(before);
  });

  it("writes a page bigger than a pipe buffer whole", () => {
    const text = "w".repeat(9000);
    for (let i = 0; i < 40; i++)
      json(run(["ui", "act", "--json"], JSON.stringify({ action: "comment", fields: { id: "t-2", text } })));
    const r = run(["ui", "page", "--json"], JSON.stringify({ path: "task/t-2" }));
    expect(r.stdout.length).toBeGreaterThan(65536);
    expect(json(r).title).toBe("yours");
  });

  it("rejects an unknown ui subcommand as usage", () => {
    expect(run(["ui", "bogus", "--json"]).status).toBe(2);
  });
});
