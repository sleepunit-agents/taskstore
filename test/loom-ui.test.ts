// taskstore as loom's tasks piece: page contract v2 (loom docs/extensions.md,
// "The page"): `ui --json` manifest, `ui page --json`, `ui act --json`.
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
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
    expect(m.tile).toEqual({ label: "Work", value: "2 in progress", detail: "1 ready, urgent or high", tone: "warn", page: "" });
    expect(m.asks.map(({ at, ...a }) => a)).toEqual([
      { text: "owner doing", meta: "Normal priority · t-4", page: "task/t-4", label: "Open", kind: "todo", attention: false },
      { text: "pick the key recovery", meta: "Low priority · t-3", page: "task/t-3", label: "Open", kind: "todo", attention: false },
    ]);
    // Each carries when it was started, else filed: loom shows its age on the card.
    expect(m.asks.every((a) => typeof a.at === "string" && !Number.isNaN(Date.parse(a.at)))).toBe(true);
  });

  it("has no warn tone when nothing at p0–p1 is ready, and honours another owner", () => {
    const m = manifest(view(state([{ op: "create", title: "x", priority: 2 }, { op: "update", id: "t-1", set: { assignee: "gage" } }]), "gage"));
    expect(m.tile).toEqual({ label: "Work", value: "0 in progress", detail: "0 ready, urgent or high", page: "" });
    expect(m.asks.map((a) => a.meta)).toEqual(["Normal priority · t-1"]);
  });

  it("files the owner's tasks as to-dos; only p0–p1 needs the owner now (loom's Inbox counts it)", () => {
    const m = manifest(view(state([{ op: "create", title: "hot", priority: 1 }, { op: "update", id: "t-1", set: { assignee: "gage" } },
      { op: "create", title: "cold", priority: 3 }, { op: "update", id: "t-2", set: { assignee: "gage" } }]), "gage"));
    expect(m.asks.map((a) => [a.text, a.kind, a.attention])).toEqual([["hot", "todo", undefined], ["cold", "todo", false]]);
  });

  it("caps asks at 10", () => {
    const ops = Array.from({ length: 12 }, () => ({ op: "create", title: "x" }));
    const s = state([...ops, ...ops.map((_, i) => ({ op: "update", id: `t-${i + 1}`, set: { assignee: "jonathan" } }))]);
    expect(manifest(view(s)).asks).toHaveLength(10);
  });
});

describe("Work page", () => {
  it("is the board's Tasks: Open · Blocked · Done counts and pills, then yours, in progress, ready", () => {
    const p = page(view(base()), { path: "", query: {} });
    expect(p.title).toBe("Tasks");
    expect(block(p, "summary", "stats")!.items!.map((i) => [i.label, i.value])).toEqual([["Open", "5"], ["Blocked", "1"], ["Done · 7d", "1"]]);
    expect(block(p, "summary", "stats")!.items![1]).toMatchObject({ tone: "warn", page: "?show=blocked" });
    expect(block(p, "summary", "filters")).toMatchObject({ param: "show", options: [{ value: "", label: "Open" }, { value: "blocked", label: "Blocked" }, { value: "done", label: "Done" }] });
    const items = block(p, "open", "list")!.items!;
    // The owner's first (waiting on you), then the rest in progress, then ready; each once.
    expect(items.map((i) => [i.page, i.tone ?? ""])).toEqual([["task/t-4", "warn"], ["task/t-3", "warn"], ["task/t-1", ""], ["task/t-2", ""]]);
    expect(items[0]).toMatchObject({ text: "owner doing", meta: "Waiting on you · Normal priority · t-4", agent: "jonathan" });
    expect(items[2]).toMatchObject({ meta: "Working on it · art · High priority · t-1", agent: "art" });
    expect(items[3]).toMatchObject({ meta: "Ready · Urgent priority · t-2" });
    expect(items[3]).not.toHaveProperty("agent");
  });

  it("Blocked names what each waits on; Done is the last week, newest first", () => {
    const b = page(view(base()), { path: "", query: { show: "blocked" } });
    expect(block(b, "blocked", "list")!.items).toEqual([{ text: "blocked", meta: "Blocked by t-1 · Normal priority · t-6", tone: "muted", page: "task/t-6" }]);
    const d = page(view(base()), { path: "", query: { show: "done" } });
    expect(block(d, "done", "list")!.items!.map((i) => i.page)).toEqual(["task/t-5"]);
    expect(block(d, "done", "list")!.items![0]).toMatchObject({ tone: "ok", meta: "Done 12:09 PM · High priority · t-5" });
  });

  it("priority still narrows, and a bad filter value is ignored", () => {
    const p = page(view(base()), { path: "", query: { priority: "3" } });
    expect(section(p, "open")!.title).toBe("Open, low priority");
    expect(block(p, "open", "list")!.items!.map((i) => i.page)).toEqual(["task/t-3"]);
    expect(section(page(view(base()), { path: "", query: { priority: "9", show: "nope" } }), "open")!.title).toBeUndefined();
  });

  it("pages past the cap: 50 a page, ?page=n, and the list says where it is (loom draws the pager)", () => {
    const s = state(Array.from({ length: 60 }, (_, i) => ({ op: "create", title: `x${i}`, priority: 1 })));
    const p1 = page(view(s), { path: "" });
    expect(block(p1, "open", "list")!.items).toHaveLength(50);
    expect(block(p1, "open", "list")!.pages).toEqual({ param: "page", at: 1, count: 2, total: 60 });
    const p2 = page(view(s), { path: "", query: { page: "2" } });
    expect(block(p2, "open", "list")!.items).toHaveLength(10);
    expect(block(p2, "open", "list")!.pages).toMatchObject({ at: 2, count: 2 });
    // Page 2 is the rest: nothing on both.
    const titles = (p: ReturnType<typeof page>) => block(p, "open", "list")!.items!.map((i) => i.text);
    expect(titles(p2).some((t) => titles(p1).includes(t))).toBe(false);
    // A page past the end, or not a page at all, is the first.
    expect(block(page(view(s), { path: "", query: { page: "9" } }), "open", "list")!.pages).toMatchObject({ at: 1 });
    expect(block(page(view(s), { path: "", query: { page: "two" } }), "open", "list")!.pages).toMatchObject({ at: 1 });
    // One page's worth says nothing about pages.
    expect(block(page(view(base()), { path: "" }), "open", "list")!.pages).toBeUndefined();
  });
});

describe("task page", () => {
  it("is the board's Task: the description as prose, Mark done, comments with marks, a Reply", () => {
    const p = page(view(base()), { path: "task/t-6", query: {} });
    expect(p.title).toBe("blocked");
    expect(p.intro).toBe("Open (blocked) · Normal priority · t-6");
    expect(block(p, "facts", "kv")!.items).toEqual([
      { label: "status", value: "Open (blocked)" },
      { label: "priority", value: "Normal" },
      { label: "assignee", value: "nobody" },
      { label: "opened", value: "12:09 PM by art" },
      { label: "parent", value: "t-7 an epic", page: "task/t-7" },
      { label: "depends on", value: "t-1 doing one", page: "task/t-1" },
    ]);
    expect(section(p, "facts")!.side).toBe(true);
    expect(block(p, "task", "buttons")!.items).toEqual([{ action: "close", label: "Mark done", tone: "primary", fields: { id: "t-6" } }]);
    expect(block(p, "comments", "list")!.items).toEqual([{ text: "first note", meta: "art · 12:30 PM", agent: "art" }]);
    expect(block(p, "reply", "form")).toMatchObject({ action: "comment", title: "Reply", submit: "Send", hidden: { id: "t-6" }, fields: [{ name: "text", label: "Reply", kind: "textarea", required: true }] });
    expect(block(p, "task", "link")).toBeUndefined();   // loom's own back link does this now
  });

  it("the description is prose; the owner's task asks for their call; a closed one offers Reopen", () => {
    const one = page(view(base()), { path: "task/t-1" });
    expect(block(one, "task", "prose")).toEqual({ type: "prose", text: "Why and how." });
    expect(block(one, "facts", "kv")!.items).toContainEqual({ label: "started", value: "12:09 PM" });
    expect(block(one, "task", "callout")).toBeUndefined();
    const mine = page(view(base()), { path: "task/t-4" });
    expect(block(mine, "task", "callout")).toMatchObject({ title: "Waiting on you", tone: "warn" });
    expect(block(mine, "reply", "form")!.fields).toMatchObject([{ label: "Your call" }]);
    expect(block(page(view(base()), { path: "task/t-5" }), "task", "buttons")!.items).toEqual([{ action: "reopen", label: "Reopen", fields: { id: "t-5" } }]);
  });

  it("answers Not found for an unknown id, an unknown path, and malformed requests", () => {
    const v = view(base());
    for (const req of [{ path: "task/t-999" }, { path: "nope" }, { path: "task/../t-1" }, { path: 7 }, null, "x", [], {}])
      expect(page(v, req)).toEqual(NOT_FOUND);
  });

  it("never emits a link a page path can't carry", () => {
    const s = state([{ op: "import", tasks: [{ id: "BD-1", title: "legacy", type: "task", status: "open", priority: 1, createdAt: AT, createdBy: "art", comments: [] }], links: [] }]);
    const m = manifest(view(s));
    const items = block(page(view(s), { path: "" }), "open", "list")!.items!;
    expect(items[0]).toEqual({ text: "legacy", meta: "Ready · High priority · BD-1" });
    expect(m.tile.value).toBe("0 in progress");
  });

  it("keeps every string within the contract: 2000 a string, 20000 for prose", () => {
    const long = "y".repeat(25000);
    const s = state([{ op: "create", title: "t", description: long }, { op: "comment", id: "t-1", text: "z".repeat(5000) }]);
    const p = page(view(s), { path: "task/t-1" });
    expect((block(p, "task", "prose")!.text as string).length).toBe(20000);
    expect((block(p, "comments", "list")!.items![0].text as string).length).toBe(2000);
  });
});

describe("humanDate", () => {
  it("is 12-hour with AM/PM in the given zone: the time alone today, the date another day, the year another year", () => {
    const now = new Date(AT);
    expect(humanDate(AT, now, "America/Chicago")).toBe("12:09 PM");
    expect(humanDate(AT, now, "UTC")).toBe("5:09 PM");
    expect(humanDate("2026-10-23T04:40:00Z", now, "America/Chicago")).toBe("Oct 22, 11:40 PM");
    expect(humanDate("2025-01-02T09:05:00Z", now, "UTC")).toBe("Jan 2, 2025, 9:05 AM");
    expect(humanDate(AT, now, "Not/AZone")).toMatch(/^\d+:09 [AP]M$/);
  });
});

describe("priority in words", () => {
  it("names 0..4 Urgent, High, Normal, Low, Someday; the New task form offers them by name", () => {
    const words = [0, 1, 2, 3, 4].map((n) => block(page(view(state([{ op: "create", title: "x", priority: n }])), { path: "task/t-1" }), "facts", "kv")!.items![1].value);
    expect(words).toEqual(["Urgent", "High", "Normal", "Low", "Someday"]);
    const form = block(page(view(base()), { path: "new" }), "new", "form")!;
    expect((form.fields as Array<Record<string, unknown>>).find((f) => f.name === "priority")!.options)
      .toEqual([{ value: "1", label: "High" }, { value: "2", label: "Normal" }, { value: "3", label: "Low" }, { value: "4", label: "Someday" }]);
  });
});

describe("checkAct", () => {
  const v = view(base());
  it("accepts a comment on a real task, trimmed; Mark done on an open one; Reopen on a closed one", () => {
    expect(checkAct(v, { action: "comment", path: "task/t-1", fields: { id: "t-1", text: "  go  " } })).toEqual({ ok: true, action: "comment", id: "t-1", text: "go" });
    expect(checkAct(v, { action: "close", fields: { id: "t-1" } })).toEqual({ ok: true, action: "close", id: "t-1" });
    expect(checkAct(v, { action: "reopen", fields: { id: "t-5" } })).toEqual({ ok: true, action: "reopen", id: "t-5" });
  });
  it("refuses everything else with a message", () => {
    for (const req of [
      null, "x", [],
      { action: "close", fields: { id: "t-5" } },     // already done
      { action: "reopen", fields: { id: "t-1" } },    // not closed
      { action: "delete", fields: { id: "t-1" } },
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
    const m = json(run(["ui", "--json"], "", { TASKSTORE_OWNER: "jonathan" }));
    expect(m).toMatchObject({ v: 2, tab: { label: "Tasks" }, tile: { value: "1 in progress", detail: "0 ready, urgent or high" } });
    expect(m.asks).toEqual([{ text: "yours", meta: "Normal priority · t-2", page: "task/t-2", label: "Open", at: expect.any(String), kind: "todo", attention: false }]);
  });

  it("ui page --json answers both pages, and Not found for junk", () => {
    expect(json(run(["ui", "page", "--json"], JSON.stringify({ path: "", query: {} }))).title).toBe("Tasks");
    expect(json(run(["ui", "page", "--json"], JSON.stringify({ path: "task/t-1" }))).title).toBe("doing");
    for (const input of ["", "not json", "[]", JSON.stringify({ path: "task/t-404" })])
      expect(json(run(["ui", "page", "--json"], input))).toEqual({ title: "Not found", sections: [] });
  });

  it("with no TASKSTORE_OWNER there are no asks, and a page comment is posted as loom-page", () => {
    expect(json(run(["ui", "--json"])).asks).toEqual([]);
    expect(json(run(["ui", "act", "--json"], JSON.stringify({ action: "comment", path: "", fields: { id: "t-2", text: "from the page" } }))).ok).toBe(true);
    expect((JSON.parse(run(["show", "t-2"]).stdout).task as Task).comments.at(-1)).toMatchObject({ actor: "loom-page", text: "from the page" });
  });

  it("ui act --json adds the comment as the owner through the core", () => {
    const r = json(run(["ui", "act", "--json"], JSON.stringify({ action: "comment", path: "task/t-1", fields: { id: "t-1", text: "Go with A." } }), { TASKSTORE_OWNER: "gage" }));
    expect(r).toEqual({ ok: true, message: "Comment added.", page: "task/t-1" });
    const shown = JSON.parse(run(["show", "t-1"]).stdout).task as Task;
    expect(shown.comments.at(-1)).toMatchObject({ actor: "gage", text: "Go with A." });
    const p = json(run(["ui", "page", "--json"], JSON.stringify({ path: "task/t-1" })));
    expect(p.sections.find((s: { id: string }) => s.id === "comments").blocks[0].items[0].text).toBe("Go with A.");
  });

  it("ui act --json: Mark done closes it through the core and offers Undo, which reopens it", () => {
    const done = json(run(["ui", "act", "--json"], JSON.stringify({ action: "close", path: "task/t-1", fields: { id: "t-1" } }), { TASKSTORE_OWNER: "gage" }));
    expect(done).toEqual({ ok: true, message: "t-1 is done.", page: "task/t-1", undo: { action: "reopen", fields: { id: "t-1" } } });
    expect((JSON.parse(run(["show", "t-1"]).stdout).task as Task).status).toBe("closed");
    const again = json(run(["ui", "act", "--json"], JSON.stringify({ action: "reopen", path: "task/t-1", fields: { id: "t-1" } }), { TASKSTORE_OWNER: "gage" }));
    expect(again).toEqual({ ok: true, message: "t-1 is open again.", page: "task/t-1" });
    expect((JSON.parse(run(["show", "t-1"]).stdout).task as Task).status).toBe("open");
  });

  it("the board's +: Tasks links New task, whose form files one through the core, the owner's when asked", () => {
    expect(json(run(["ui", "page", "--json"], JSON.stringify({ path: "", query: {} }))).add).toEqual({ page: "new", label: "New task" });
    const form = json(run(["ui", "page", "--json"], JSON.stringify({ path: "new" }), { TASKSTORE_OWNER: "jonathan" })).sections[0].blocks[0];
    expect(form.action).toBe("create");
    expect(form.fields.map((f: { name: string }) => f.name)).toEqual(["title", "priority", "mine", "description"]);
    const r = json(run(["ui", "act", "--json"], JSON.stringify({ action: "create", path: "new", fields: { title: "  Water the kiln  ", priority: "1", mine: "1", description: "Cone 6." } }), { TASKSTORE_OWNER: "jonathan" }));
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/^t-\d+ is filed\.$/) });
    const id = String(r.page).replace("task/", "");
    expect(JSON.parse(run(["show", id]).stdout).task).toMatchObject({ title: "Water the kiln", priority: 1, assignee: "jonathan", description: "Cone 6.", createdBy: "jonathan" });
    expect(json(run(["ui", "act", "--json"], JSON.stringify({ action: "create", fields: { title: "   " } }))).ok).toBe(false);
  });

  it("the owner's comment from the page: their initial on the row, the task back to the agent, and the hook run", async () => {
    expect(run(["update", "t-2", "--assignee", "jonathan"]).status).toBe(0);
    const mark = join(mkdtempSync(join(tmpdir(), "taskstore-hook-")), "woke");
    const env = { TASKSTORE_OWNER: "jonathan", TASKSTORE_AGENTS: "art,mark", TASKSTORE_ON_OWNER_COMMENT: JSON.stringify(["sh", "-c", `echo {id} > ${mark}`]) };
    const r = json(run(["ui", "act", "--json"], JSON.stringify({ action: "comment", path: "task/t-2", fields: { id: "t-2", text: "close it" } }), env));
    expect(r).toEqual({ ok: true, message: "Comment added. Art picks it up.", page: "task/t-2" });
    expect((JSON.parse(run(["show", "t-2"]).stdout).task as Task).assignee).toBe("art");
    for (let i = 0; i < 50 && !existsSync(mark); i++) await new Promise((res) => setTimeout(res, 20));
    expect(readFileSync(mark, "utf8").trim()).toBe("t-2");
    const p = json(run(["ui", "page", "--json"], JSON.stringify({ path: "task/t-2" }), { TASKSTORE_OWNER: "jonathan" }));
    const last = p.sections.find((x: { id: string }) => x.id === "comments").blocks[0].items.at(-1);
    expect(last).toMatchObject({ text: "close it", avatar: "J" });
    expect(last.agent).toBeUndefined();
    // No hook set: the comment is added and the task still goes back, but nothing claims to pick it up.
    expect(run(["update", "t-2", "--assignee", "jonathan"]).status).toBe(0);
    expect(json(run(["ui", "act", "--json"], JSON.stringify({ action: "comment", fields: { id: "t-2", text: "x" } }), { TASKSTORE_OWNER: "jonathan", TASKSTORE_AGENTS: "art" })).message).toBe("Comment added.");
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
