// taskstore as loom's tasks piece: page contract v2 (loom docs/extensions.md,
// "The page"): `ui --json` manifest, `ui page --json`, `ui act --json`.
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, emptyState, type Command, type StoreState, type Task } from "../src/core.js";
import { CHANGES_SHOWN, changeRefs, checkAct, humanDate, manifest, page, NOT_FOUND, type UiView } from "../src/loom-ui.js";

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
/** The task's facts panel's rows. */
const rows = (p: ReturnType<typeof page>) => block(p, "facts", "panel")!.rows as Array<Record<string, unknown>>;

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
  it("reports all open assigned or agent-created work as backlog without claiming it is running", () => {
    const v = { ...view(base()), agents: ["art", "mark"] };
    expect(manifest(v).agents.art.jobs.map((j) => [j.id, j.status])).toEqual([["t-1", "backlog"], ["t-2", "backlog"], ["t-6", "backlog"]]);
    expect(manifest(v).agents.mark.jobs).toEqual([]);
    expect(manifest(v)).not.toHaveProperty("owners");
  });

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
  it("is groups, each task once: waiting on you, in progress, blocked, up next; no counts or pills", () => {
    const p = page(view(base()), { path: "", query: {} });
    expect(p.title).toBe("Tasks");
    expect(p.sections.map((s) => [s.id, s.title, s.fold, s.place])).toEqual([
      ["yours", "Waiting on you · 2", "open", undefined], ["doing", "In progress · 1", "open", undefined], ["blocked", "Blocked · 1", "open", undefined],
      ["next", "Up next · 1", "open", undefined], ["done", "Done in the last 7 days · 1", "closed", undefined],
      // loom's side column: find and sort, the chart, and what moved last.
      ["show", "Find and sort", undefined, "side"], ["weeks", "Opened and done", undefined, "side"], ["recent", "Recently updated", undefined, "side"],
    ]);
    expect(block(p, "yours", "list")!.who).toBe(true);
    expect(section(p, "yours")!.tone).toBe("warn");
    expect(block(p, "yours", "list")!.items!.map((i) => i.page)).toEqual(["task/t-4", "task/t-3"]);
    // No caller: the owner's tasks wear their initial and their name.
    expect(block(p, "yours", "list")!.items![0]).toMatchObject({ text: "owner doing", meta: "Needs a plain summary · jonathan · Normal · t-4", avatar: "J" });
    expect(block(p, "doing", "list")!.items).toEqual([{ text: "doing one", meta: "Needs a plain summary · art · High · t-1", agent: "art", page: "task/t-1" }]);
    expect(block(p, "blocked", "list")!.items).toEqual([{ text: "blocked", meta: "Needs a plain summary · Waiting on t-1 · Normal · t-6", page: "task/t-6" }]);
    expect(block(p, "next", "list")!.items).toEqual([{ text: "urgent ready", meta: "Needs a plain summary · Urgent · t-2", page: "task/t-2" }]);
    // The main column is the list: no stats, no chart and no filters in it.
    expect(p.sections.filter((s) => !s.place).some((s) => s.blocks.some((b) => ["stats", "filters", "chart"].includes(b.type)))).toBe(false);
  });

  it("splits the ready queue by priority: up next (urgent, high), ready (normal), later (low, someday)", () => {
    const s = state([0, 1, 2, 3, 4].map((priority) => ({ op: "create", title: `p${priority}`, priority })));
    const p = page(view(s, ""), { path: "" });
    const of = (id: string) => block(p, id, "list")!.items!.map((i) => i.text);
    expect([of("next"), of("ready"), of("later")]).toEqual([["p0", "p1"], ["p2"], ["p3", "p4"]]);
    // No tone dot on any row: the group says it.
    expect(p.sections.flatMap((s) => s.blocks.flatMap((b) => (b as Blk).items ?? [])).some((i) => "tone" in i)).toBe(false);
    expect(block(p, "ready", "list")!.items![0].meta).toBe("Needs a plain summary · t-3");
  });

  it("folds the last week's done at the foot, newest first, and the long queue too", () => {
    const p = page(view(base()), { path: "" });
    const items = block(p, "done", "list")!.items!;
    expect(items.map((i) => i.page)).toEqual(["task/t-5"]);
    // Read like every other row: whose, priority, id, then when.
    expect(items[0]).toMatchObject({ meta: "Needs a plain summary · jonathan · High · t-5 · 12:09 PM" });
    expect(items[0]).not.toHaveProperty("tone");
    const q = page(view(state([2, 3].map((priority) => ({ op: "create", title: `p${priority}`, priority })))), { path: "" });
    expect([section(q, "ready")!.fold, section(q, "later")!.fold]).toEqual(["closed", "closed"]);
  });

  it("the owner is you, in their own avatar, when a household owner is looking (loom's caller)", () => {
    const owner = { kind: "owner", who: "jonathan-barket", agents: "*" };
    const p = page(view(base()), { path: "", caller: owner });
    expect(block(p, "yours", "list")!.items![0]).toMatchObject({ meta: "Needs a plain summary · you · Normal · t-4", person: "jonathan-barket" });
    expect(block(p, "yours", "list")!.items![0]).not.toHaveProperty("agent");
    // An agent's owner, or a caller that isn't one, isn't "you".
    for (const caller of [{ ...owner, agents: ["mark"] }, { kind: "stranger" }, { ...owner, who: "Not A Slug" }]) {
      expect(block(page(view(base()), { path: "", caller }), "yours", "list")!.items![0]).toMatchObject({ meta: "Needs a plain summary · jonathan · Normal · t-4", avatar: "J" });
    }
    const t = page(view(base()), { path: "task/t-4", caller: owner });
    expect(rows(t).find((i) => i.label === "Whose")).toEqual({ label: "Whose", value: "you" });
  });

  it("charts what was opened and done each week, the last 8, this one last", () => {
    const c = block(page(view(base()), { path: "" }), "weeks", "chart")!;
    expect(c).toMatchObject({ kind: "bar", caption: "By week", summary: { label: "Open", value: "5", detail: "+6 this week" } });
    // Two series, each named and each its own colour (loom keeps them apart, and draws the names in the legend).
    const series = c.series as Array<{ key: string; label: string; color: string }>;
    expect(series.map((x) => x.label)).toEqual(["Opened", "Done"]);
    expect(new Set(series.map((x) => x.color)).size).toBe(2);
    expect(section(page(view(base()), { path: "" }), "weeks")!.place).toBe("side");
    const data = c.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(8);
    expect(data[7]).toEqual({ label: "This week", opened: 7, done: 1 });
    expect(data[0]).toEqual({ label: "Aug 31", opened: 0, done: 0 });
  });

  it("pages each group on its own: 15 a page, ?<group>=n, the list saying where it is", () => {
    const s = state(Array.from({ length: 20 }, (_, i) => ({ op: "create", title: `x${i}`, priority: 2 })));
    const p1 = page(view(s), { path: "" });
    expect(section(p1, "ready")!.title).toBe("Ready · 20");
    expect(block(p1, "ready", "list")!.items).toHaveLength(15);
    expect(block(p1, "ready", "list")!.pages).toEqual({ param: "ready", at: 1, count: 2, total: 20 });
    const p2 = page(view(s), { path: "", query: { ready: "2" } });
    expect(block(p2, "ready", "list")!.items).toHaveLength(5);
    expect(block(page(view(s), { path: "", query: { ready: "9" } }), "ready", "list")!.pages).toMatchObject({ at: 1 });
    expect(block(page(view(base()), { path: "" }), "next", "list")!.pages).toBeUndefined();
  });

  it("says so when there's nothing", () => {
    expect(page(view(emptyState()), { path: "" }).sections.filter((s) => !s.place)).toEqual([{ id: "empty", blocks: [{ type: "text", text: "Nothing open.", tone: "muted" }] }]);
    // Nothing has moved, so nothing is recently updated.
    expect(section(page(view(emptyState()), { path: "" }), "recent")).toBeUndefined();
  });

  it("finds tasks by id, title, goal or ask (?q=), across every group, and says when nothing matches", () => {
    // By goal and by ask, words that are in no title or id.
    const s = state([
      { op: "create", title: "one", priority: 2, goal: "The backup has an offsite copy" },
      { op: "create", title: "two", priority: 2 },
      { op: "update", id: "t-2", set: { ask: "OK to install rclone?", assignee: "jonathan", ifYes: "I install it.", ifNo: "I don't." } },
      { op: "create", title: "three", priority: 2 },
    ]);
    const found = (q: string) => page(view(s), { path: "", query: { q } }).sections.filter((x) => !x.place)
      .flatMap((x) => (x.blocks[0].items as Array<{ page?: string }> | undefined) ?? []).map((i) => i.page);
    expect(found("offsite")).toEqual(["task/t-1"]);
    expect(found("RCLONE")).toEqual(["task/t-2"]);
    const p = page(view(base()), { path: "", query: { q: "OWNER" } });
    expect(p.intro).toBe("Finding “OWNER”");
    expect(p.sections.filter((s) => !s.place).map((s) => s.id)).toEqual(["yours", "done"]);
    expect(block(p, "yours", "list")!.items!.map((i) => i.page)).toEqual(["task/t-4"]);
    expect(block(page(view(base()), { path: "", query: { q: "t-2" } }), "next", "list")!.items!.map((i) => i.page)).toEqual(["task/t-2"]);
    const none = page(view(base()), { path: "", query: { q: "zebra" } });
    expect(none.sections.filter((s) => !s.place)).toEqual([{ id: "empty", blocks: [{ type: "text", text: "Nothing matches “zebra”.", tone: "muted" }] }]);
    // The side column stays: the way to change the search is there.
    // One search field, one sort switch, and a row of status chips (Jonathan's Tasks mock, t-1925).
    expect(section(none, "show")!.blocks[0]).toEqual({ type: "filters", param: "sort", search: "Find a task", switch: true,
      options: [{ value: "", label: "Priority" }, { value: "new", label: "Newest" }, { value: "updated", label: "Updated" }],
      chips: [{ param: "show", label: "Status", options: [{ value: "yours", label: "Needs you" }, { value: "doing", label: "In progress" },
        { value: "blocked", label: "Blocked" }, { value: "open", label: "Open" }, { value: "done", label: "Done" }] }] });
  });

  it("draws only the groups whose status chips are on (?show=a,b); none on, or only unknown ones, is every group", () => {
    const main = (show?: string) => page(view(base()), { path: "", query: show === undefined ? {} : { show } }).sections.filter((s) => !s.place).map((s) => s.id);
    const all = main();
    expect(all).toEqual(["yours", "doing", "blocked", "next", "done"]);
    expect(main("doing")).toEqual(["doing"]);
    expect(main("yours,done")).toEqual(["yours", "done"]);
    expect(main("open")).toEqual(["next"]);
    // Open is the whole ready queue: up next, ready and later.
    const q = state([0, 2, 3].map((priority) => ({ op: "create", title: `p${priority}`, priority })));
    expect(page(view(q, ""), { path: "", query: { show: "open" } }).sections.filter((s) => !s.place).map((s) => s.id)).toEqual(["next", "ready", "later"]);
    expect(main("zebra")).toEqual(all);
    expect(main("")).toEqual(all);
    // A task taken by a hidden group doesn't move into another: the owner's in-progress task stays out of In progress.
    const doing = block(page(view(base()), { path: "", query: { show: "doing" } }), "doing", "list")!.items!.map((i) => i.page);
    expect(doing).toEqual(["task/t-1"]);
    // Nothing in the chips that are on: said so, and the side column stays.
    const none = page(view(state([{ op: "create", title: "x", priority: 2 }])), { path: "", query: { show: "done" } });
    expect(none.sections.filter((s) => !s.place)).toEqual([{ id: "empty", blocks: [{ type: "text", text: "Nothing here. Turn another chip on.", tone: "muted" }] }]);
    expect(section(none, "show")).toBeDefined();
  });

  it("a row opens in place to its goal, why and done-when, with Open task inside; one with none of them just links", () => {
    const s = state([
      { op: "create", title: "full", priority: 1, goal: "It works", why: "It broke", doneWhen: "Tested twice" },
      { op: "create", title: "half", priority: 1, goal: "Only a goal" },
      { op: "create", title: "bare", priority: 1 },
    ]);
    const items = block(page(view(s), { path: "" }), "next", "list")!.items! as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ text: "full", page: "task/t-1",
      more: { items: [{ label: "Goal", value: "It works" }, { label: "Why", value: "It broke" }, { label: "Done when", value: "Tested twice" }], open: "Open task" } });
    expect(items[1].more).toEqual({ items: [{ label: "Goal", value: "Only a goal" }], open: "Open task" });
    expect(items[2]).not.toHaveProperty("more");
    expect(items[2].page).toBe("task/t-3");
    // A waiting-on-you row (its ask as its title) opens the same way.
    const asked = state([{ op: "create", title: "ask me", priority: 1, goal: "G", why: "W" },
      { op: "update", id: "t-1", set: { assignee: "jonathan", ask: "OK?", ifYes: "y", ifNo: "n" } }]);
    expect(block(page(view(asked), { path: "" }), "yours", "list")!.items![0]).toMatchObject({ text: "OK?",
      more: { items: [{ label: "Goal", value: "G" }, { label: "Why", value: "W" }], open: "Open task" } });
    // A long one is cut to loom's 2000 characters, never sent whole (loom would refuse the page).
    const long = state([{ op: "create", title: "long", priority: 1, goal: "g".repeat(5000) }]);
    const value = (block(page(view(long), { path: "" }), "next", "list")!.items![0] as { more: { items: Array<{ value: string }> } }).more.items[0].value;
    expect(value).toHaveLength(2000);
    // A task whose id no page path can carry opens in place without an Open task (there's nowhere to open).
    const legacy = state([{ op: "import", tasks: [{ id: "BD-1", title: "legacy", type: "task", status: "open", priority: 1, createdAt: AT, createdBy: "art", comments: [], goal: "Old goal" }], links: [] }]);
    expect(block(page(view(legacy), { path: "" }), "next", "list")!.items![0]).toEqual({ text: "legacy", meta: "Old goal · High · BD-1",
      more: { items: [{ label: "Goal", value: "Old goal" }] } });
  });

  it("sorts each group (?sort=): by priority as the groups have it, newest first, or most recently touched first", () => {
    const s = state([
      { op: "create", title: "old", priority: 2, at: "2026-10-01T10:00:00Z" },
      { op: "create", title: "new", priority: 2, at: "2026-10-20T10:00:00Z" },
      { op: "create", title: "mid", priority: 2, at: "2026-10-10T10:00:00Z" },
      { op: "comment", id: "t-3", text: "poked", at: "2026-10-23T10:00:00Z" },
    ]);
    const order = (sort?: string) => block(page(view(s), { path: "", query: sort === undefined ? {} : { sort } }), "ready", "list")!.items!.map((i) => i.text);
    expect(order()).toEqual(["old", "new", "mid"]);
    expect(order("new")).toEqual(["new", "mid", "old"]);
    // Updated: the comment on "mid" moved it to the top.
    expect(order("updated")).toEqual(["mid", "new", "old"]);
    expect(order("nonsense")).toEqual(order());
  });

  it("lists the 8 most recently touched tasks beside the list, newest first, each linking to its page", () => {
    const s = state([
      ...Array.from({ length: 10 }, (_, i) => ({ op: "create", title: `task ${i + 1}`, priority: 2, at: `2026-10-${String(10 + i).padStart(2, "0")}T10:00:00Z` })),
      { op: "comment", id: "t-2", text: "poked", at: "2026-10-23T18:00:00Z" },
      { op: "claim", id: "t-3", at: "2026-10-22T18:00:00Z" },
    ]);
    const items = block(page(view(s), { path: "" }), "recent", "list")!.items!;
    expect(items).toHaveLength(8);
    expect(items.map((i) => i.page)).toEqual(["task/t-2", "task/t-3", "task/t-10", "task/t-9", "task/t-8", "task/t-7", "task/t-6", "task/t-5"]);
    expect(items[0]).toMatchObject({ text: "task 2", meta: "t-2 · Open · Oct 23, 1:00 PM" });
    expect(items[1]).toMatchObject({ meta: "t-3 · In progress · Oct 22, 1:00 PM", agent: "art" });
  });
});

describe("task page", () => {
  it("is the board's Task: the description as prose, Mark done, comments with marks, a Reply", () => {
    const p = page(view(base()), { path: "task/t-6", query: {} });
    expect(p.title).toBe("blocked");
    expect(p.intro).toBe("Open (blocked) · Normal priority · t-6");
    // The facts are an app's panel: each value in words, priority in a sheet, linked tasks by title, ids behind a sheet.
    const options = ["Urgent", "High", "Normal", "Low", "Someday"].map((label, i) => ({ value: String(i), label }));
    expect(rows(p)).toEqual([
      { label: "Status", value: "Open (blocked)" },
      { label: "Priority", value: "Normal", edit: { action: "priority", title: "Priority", submit: "Set", hidden: { id: "t-6" },
        fields: [{ name: "priority", label: "How urgent", kind: "segmented", value: "2", options }] } },
      { label: "Whose", value: "Nobody's yet" },
      { label: "Opened", value: "12:09 PM", detail: "by art" },
      { label: "Part of", value: "an epic", detail: "t-7", page: "task/t-7" },
      { label: "Waits on", value: "doing one", detail: "t-1", tone: "warn", page: "task/t-1" },
      { label: "Record", value: "Its ids and refs", sheet: { title: "t-6", blocks: [{ type: "kv", items: [{ label: "Task", value: "t-6" }] }] } },
    ]);
    expect(section(p, "facts")!.place).toBe("side");
    expect(block(p, "task", "buttons")!.items).toEqual([{ action: "close", label: "Mark done", tone: "primary", fields: { id: "t-6" } }]);
    expect(block(p, "comments", "list")).toEqual({ type: "list", wrap: true, items: [{ text: "first note", meta: "art · 12:30 PM", agent: "art" }] });
    expect(block(p, "reply", "form")).toMatchObject({ action: "comment", title: "Reply", submit: "Send", hidden: { id: "t-6" }, fields: [{ name: "text", label: "Reply", kind: "textarea", required: true }] });
    expect(block(p, "task", "link")).toBeUndefined();   // loom's own back link does this now
  });

  it("the description is prose; the owner's task asks for their call; a closed one offers Reopen", () => {
    const one = page(view(base()), { path: "task/t-1" });
    expect(block(one, "background", "prose")).toEqual({ type: "prose", text: "Why and how." });
    expect(section(one, "background")!.fold).toBe("open"); // all there is: open
    expect(rows(one)).toContainEqual({ label: "Started", value: "12:09 PM" });
    expect(block(one, "task", "callout")).toBeUndefined();
    const mine = page(view(base()), { path: "task/t-4" });
    expect(block(mine, "task", "callout")).toMatchObject({ title: "Waiting on you", tone: "warn" });
    expect(block(mine, "reply", "form")!.fields).toMatchObject([{ label: "Your call" }]);
    expect(block(page(view(base()), { path: "task/t-5" }), "task", "buttons")!.items).toEqual([{ action: "reopen", label: "Reopen", fields: { id: "t-5" } }]);
  });

  it("reads [[t-NNN]] as plain t-NNN (not a dead knowledge link) and lists the tasks it mentions, linked", () => {
    const s = state([
      { op: "create", title: "cites", description: "See [[t-2]], [[t-2]] again, [[t-9]] (gone), [[t-1]] (itself) and [[a-page]]." },
      { op: "create", title: "the other one" },
      { op: "create", title: "from a comment" },
      { op: "comment", id: "t-1", text: "Also [[t-3]]." },
    ]);
    const p = page(view(s), { path: "task/t-1" });
    expect(block(p, "background", "prose")!.text).toBe("See t-2, t-2 again, t-9 (gone), t-1 (itself) and [[a-page]].");
    expect(block(p, "comments", "list")!.items![0].text).toBe("Also t-3.");
    expect(block(p, "mentioned", "list")!.items).toEqual([
      { text: "the other one", meta: "t-2 · Open", page: "task/t-2" },
      { text: "from a comment", meta: "t-3 · Open", page: "task/t-3" },
    ]);
    expect(section(page(view(base()), { path: "task/t-1" }), "mentioned")).toBeUndefined();
  });

  it("answers Not found for an unknown id, an unknown path, and malformed requests", () => {
    const v = view(base());
    for (const req of [{ path: "task/t-999" }, { path: "nope" }, { path: "task/../t-1" }, { path: 7 }, null, "x", [], {}])
      expect(page(v, req)).toEqual(NOT_FOUND);
  });

  it("never emits a link a page path can't carry", () => {
    const s = state([{ op: "import", tasks: [{ id: "BD-1", title: "legacy", type: "task", status: "open", priority: 1, createdAt: AT, createdBy: "art", comments: [] }], links: [] }]);
    const m = manifest(view(s));
    const items = block(page(view(s), { path: "" }), "next", "list")!.items!;
    expect(items[0]).toEqual({ text: "legacy", meta: "Needs a plain summary · High · BD-1" });
    // Nowhere on the page, the side column's Recently updated included: every piece link fits the grammar.
    const p = page(view(s), { path: "" });
    expect(block(p, "recent", "list")!.items![0]).not.toHaveProperty("page");
    const links = JSON.stringify(p).match(/"page":"[^"]*"/g) ?? [];
    expect(links.filter((l) => !/^"page":"(loom:.*|[a-z0-9._~/-]{0,200})"$/.test(l))).toEqual([]);
    expect(m.tile.value).toBe("0 in progress");
  });

  it("keeps every string within the contract: 2000 a string, 20000 for prose", () => {
    const long = "y".repeat(25000);
    const s = state([{ op: "create", title: "t", description: long }, { op: "comment", id: "t-1", text: "z".repeat(5000) }]);
    const p = page(view(s), { path: "task/t-1" });
    expect((block(p, "background", "prose")!.text as string).length).toBe(20000);
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
    const words = [0, 1, 2, 3, 4].map((n) => rows(page(view(state([{ op: "create", title: "x", priority: n }])), { path: "task/t-1" })).find((r) => r.label === "Priority")!.value);
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
    expect(checkAct(v, { action: "priority", fields: { id: "t-1", priority: "0" } })).toEqual({ ok: true, action: "priority", id: "t-1", priority: 0 });
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
      { action: "priority", fields: { id: "t-1", priority: "7" } },
      { action: "priority", fields: { id: "t-1" } },
      { action: "priority", fields: { id: "t-999", priority: "1" } },
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
    // dist is built once, before every file (test/build.global.ts).
    db = join(mkdtempSync(join(tmpdir(), "taskstore-ui-")), "store.db");
    for (const args of [
      ["create", "doing", "--priority", "1"], ["claim", "t-1"],
      ["create", "yours", "--priority", "2"], ["update", "t-2", "--assignee", "jonathan", "--ask", "Is this yours?"],
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
    expect(m.asks).toEqual([{ text: "Is this yours?", meta: "Normal priority · t-2", page: "task/t-2", label: "Open", at: expect.any(String), kind: "todo", attention: false }]);
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

  it("ui act --json: the facts panel's priority sets it through the core", () => {
    const r = json(run(["ui", "act", "--json"], JSON.stringify({ action: "priority", path: "task/t-1", fields: { id: "t-1", priority: "0" } }), { TASKSTORE_OWNER: "gage" }));
    expect(r).toEqual({ ok: true, message: "t-1 is urgent priority now.", page: "task/t-1" });
    expect((JSON.parse(run(["show", "t-1"]).stdout).task as Task).priority).toBe(0);
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
  }, 30000); // 41 CLI runs: past vitest's 5 s on a busy machine

  it("rejects an unknown ui subcommand as usage", () => {
    expect(run(["ui", "bogus", "--json"]).status).toBe(2);
  });
});

describe("plain words: the summary and the owner's ask", () => {
  const T1273 = {
    title: "Find out why the field Pis drop off the network, using the failed Station 13 hotspot",
    goal: "We know what makes a field Pi lose its connection, from a failing unit on a bench.",
    why: "The same failure hit two sites, and we've never caught it on hardware we can test.",
    ask: "Can you get the old Station 13 hotspot and a spare Pi onto a bench I can reach?",
    ifYes: "I run the checks against a good hotspot and report what's actually wrong.",
    ifNo: "I close this and fold it into t-1.",
  };
  const s = () => state([
    { op: "create", title: "LTE hats", goal: "We know whether LTE hats replace the hotspots." },
    { op: "create", ...T1273, priority: 1, description: "Original title: pond: get the dead S13 MiFi onto a bench\n\nSame signature at WV cartage." },
    { op: "update", id: "t-2", set: { assignee: "jonathan" } },
    { op: "create", title: "Pick a name", ask: "Gabe or Mark?", answers: "words", actor: "mark" },
    { op: "update", id: "t-3", set: { assignee: "jonathan" } },
  ]);

  it("the Inbox item is the ask, with its why under it", () => {
    expect(manifest(view(s())).asks.map((a) => [a.text, a.meta, a.page])).toEqual([
      [T1273.ask, T1273.why, "task/t-2"],
      ["Gabe or Mark?", "Normal priority · t-3", "task/t-3"],
    ]);
  });

  it("the list leads with the plain title and the goal as the second line; the owner's rows lead with the ask", () => {
    const p = page(view(s()), { path: "" });
    expect(block(p, "next", "list")).toBeUndefined();
    expect(block(p, "ready", "list")!.items![0]).toMatchObject({ text: "LTE hats", meta: "We know whether LTE hats replace the hotspots. · t-1" });
    expect(block(p, "yours", "list")!.items![0]).toMatchObject({ text: T1273.ask, meta: `${T1273.why} · jonathan · High · t-2` });
  });

  it("the task page is Ask, Why, If yes, If no first, then the goal, then the background folded", () => {
    const p = page(view(s()), { path: "task/t-2" });
    expect(p.title).toBe(T1273.title);
    expect(p.sections.map((x) => x.id)).toEqual(["ask", "task", "background", "comments", "facts"]);
    expect(section(p, "ask")).toMatchObject({ title: "Waiting on you", tone: "warn" });
    expect(block(p, "ask", "callout")).toEqual({ type: "callout", title: T1273.ask, text: T1273.why, tone: "warn" });
    expect(block(p, "ask", "prose")!.text).toBe(`**If yes:** ${T1273.ifYes}\n\n**If no:** ${T1273.ifNo}`);
    expect(block(p, "ask", "form")).toEqual({
      type: "form", action: "answer", submit: "Send", hidden: { id: "t-2" },
      submits: [{ label: "Yes", fields: { answer: "yes" }, tone: "primary" }, { label: "No", fields: { answer: "no" } }],
      fields: [{ name: "text", label: "Or answer in your own words", kind: "textarea", hint: "It goes back to Art as your comment, posted as jonathan." }],
    });
    expect(block(p, "task", "prose")!.text).toBe(`**Goal:** ${T1273.goal}`);
    expect(section(p, "background")).toMatchObject({ title: "Background", fold: "closed" });
    expect(block(p, "background", "prose")!.text).toMatch(/^Original title: pond: get the dead S13 MiFi/);
    expect(section(p, "reply")).toBeUndefined(); // the ask's own form answers it
  });

  it("an ask answered in words has one box; one that isn't the owner's any more just says what it asked", () => {
    const words = page(view(s()), { path: "task/t-3" });
    expect(block(words, "ask", "form")).toMatchObject({ action: "answer", fields: [{ label: "Your answer", required: true, hint: "It goes back to Mark as your comment, posted as jonathan." }] });
    expect(block(words, "ask", "form")).not.toHaveProperty("submits");
    const back = state([{ op: "create", title: "t", ask: "Go?" }]);
    const p = page(view(back), { path: "task/t-1" });
    expect(section(p, "ask")).toMatchObject({ title: "Asked of jonathan" });
    expect(block(p, "ask", "form")).toBeUndefined();
    expect(section(p, "reply")).toBeDefined();
  });

  it("a task with no summary says it needs one, and its description is all there is, open", () => {
    const p = page(view(state([{ op: "create", title: "old", description: "a log" }])), { path: "task/t-1" });
    expect(block(p, "task", "text")!.text).toMatch(/^Needs a plain summary/);
    expect(section(p, "background")!.fold).toBe("open");
  });

  it("answers: Yes, No or words, as the owner's comment, back to the agent that asked", () => {
    const v = { ...view(s()), agents: ["art", "mark"] };
    expect(checkAct(v, { action: "answer", fields: { id: "t-2", answer: "yes", text: "  " } })).toEqual({
      ok: true, action: "answer", id: "t-2", answer: "yes", to: "art",
      text: `Yes, to: ${T1273.ask}\nIf yes, you said: ${T1273.ifYes}`,
    });
    expect(checkAct(v, { action: "answer", fields: { id: "t-2", answer: "no", text: "Patrick has it." } })).toMatchObject({
      text: `No, to: ${T1273.ask}\nIf no, you said: ${T1273.ifNo}\n\nPatrick has it.`,
    });
    expect(checkAct(v, { action: "answer", fields: { id: "t-3", text: "Gabe." } })).toEqual({
      ok: true, action: "answer", id: "t-3", to: "mark", text: "Answer, to: Gabe or Mark?\n\nGabe.",
    });
    for (const [fields, message] of [
      [{ id: "t-3", answer: "yes" }, "This one needs your words, not a Yes or a No."],
      [{ id: "t-2", answer: "maybe" }, "An answer is Yes or No."],
      [{ id: "t-2" }, "Your answer is empty."],
      [{ id: "t-1", answer: "yes" }, "That task doesn't ask anything."],
    ] as const) expect(checkAct(v, { action: "answer", fields })).toEqual({ ok: false, message });
    const answered = state([{ op: "create", title: "t", ask: "Go?" }]);
    expect(checkAct(view(answered), { action: "answer", fields: { id: "t-1", answer: "yes" } })).toMatchObject({ ok: false, message: /isn't waiting on you/ });
  });
});

describe("ui act answer (the CLI verb)", () => {
  const repo = join(__dirname, "..");
  const cli = join(repo, "dist", "cli.js");
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TASKSTORE_")));
  let db = "";
  const run = (args: string[], input = "", extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", input, env: { ...baseEnv, TASKSTORE_DB: db, ...extra } });
  beforeAll(() => {
    // dist is built once, before every file (test/build.global.ts).
    db = join(mkdtempSync(join(tmpdir(), "taskstore-answer-")), "store.db");
    expect(run(["create", "Plug in the backup drive", "--goal", "Backups have a second disk.", "--ask", "Can you plug the backup drive in?", "--if-yes", "I start the first backup."], "", { TASKSTORE_ACTOR: "mark" }).status).toBe(0);
    expect(run(["update", "t-1", "--assignee", "jonathan"]).status).toBe(0);
  }, 60000);

  it("Yes is the owner's comment, and the task goes back to the agent that asked", () => {
    const env = { TASKSTORE_OWNER: "jonathan", TASKSTORE_AGENTS: "art,mark" };
    const r = run(["ui", "act", "--json"], JSON.stringify({ action: "answer", fields: { id: "t-1", answer: "yes", text: "It's the blue one." } }), env);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, message: "You said yes. It's back with Mark.", page: "task/t-1" });
    const t = JSON.parse(run(["show", "t-1"]).stdout).task;
    expect(t.assignee).toBe("mark");
    expect(t.comments).toEqual([{ actor: "jonathan", at: expect.any(String), text: "Yes, to: Can you plug the backup drive in?\nIf yes, you said: I start the first backup.\n\nIt's the blue one." }]);
    // Answered: a second Yes finds nothing waiting.
    expect(JSON.parse(run(["ui", "act", "--json"], JSON.stringify({ action: "answer", fields: { id: "t-1", answer: "yes" } }), env).stdout)).toMatchObject({ ok: false });
  });
});

describe("a task's changes (loom docs/specs/changes.md, Linked tasks)", () => {
  const ref = { id: "github:acme/app#12", short: "app#12", title: "Fix it", words: "CI green, Waiting on you", page: "c/github/acme/app/12" };
  it("lists the changes that cite the task in a side section, each linking to its page in the Changes piece", () => {
    const p = page({ ...view(base()), changes: [ref] }, { path: "task/t-1" });
    const s = section(p, "changes")!;
    expect(s.place).toBe("side");
    expect(s.blocks[0]).toEqual({ type: "list", items: [{ text: "app#12 Fix it", meta: "CI green, Waiting on you", page: "loom:p/changes/c/github/acme/app/12" }] });
    expect(section(page(view(base()), { path: "task/t-1" }), "changes")).toBeUndefined();
  });
  it("keeps only well-formed rows from the Changes piece's answer", () => {
    expect(changeRefs([ref, { ...ref, page: "../x" }, { ...ref, page: "//evil" }, { ...ref, page: "C/X" }, { ...ref, title: 3 }, "x", null])).toEqual([ref]);
    expect(changeRefs({ not: "a list" })).toEqual([]);
  });
  it("shows at most CHANGES_SHOWN", () => {
    expect(changeRefs(Array.from({ length: 30 }, (_, i) => ({ ...ref, id: `x#${i}` }))).length).toBe(CHANGES_SHOWN);
  });

  describe("the CLI reads them from loom-changes cited-by, bounded, and the page is unchanged without it", () => {
    const repo = join(__dirname, "..");
    const cli = join(repo, "dist", "cli.js");
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TASKSTORE_")));
    let db = "";
    let dir = "";
    const run = (extra: Record<string, string>, path = "task/t-1") =>
      spawnSync(process.execPath, [cli, "ui", "page", "--json"], { encoding: "utf8", input: JSON.stringify({ path }),
        env: { ...baseEnv, TASKSTORE_DB: db, LOOM_HOME: join(dir, "loom"), ...extra } });
    const ids = (r: ReturnType<typeof run>) => (JSON.parse(r.stdout).sections as Array<{ id: string }>).map((x) => x.id);
    const script = (name: string, body: string) => {
      const p = join(dir, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
      return p;
    };
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "taskstore-changes-"));
      db = join(dir, "store.db");
      expect(spawnSync(process.execPath, [cli, "create", "Ship it", "--goal", "It ships.", "--why", "It's done."], { encoding: "utf8", env: { ...baseEnv, TASKSTORE_DB: db } }).status).toBe(0);
    }, 60000);

    it("loom-changes runs as itself: none of this piece's home, name or settings in its environment", () => {
      const seen = join(dir, "env");
      const bin = script("envcheck", `env > ${seen}; echo '[]'`);
      const r = run({ TASKSTORE_CHANGES: bin, LOOM_PIECE_HOME: "/pieces/tasks", LOOM_PIECE_NAME: "tasks", LOOM_HOME: "/the/loom", SOME_OTHER: "kept" });
      // The page itself still read its own store (its TASKSTORE_DB untouched in this process).
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).title).toBe("Ship it");
      const env = readFileSync(seen, "utf8");
      expect(env).toMatch(/^SOME_OTHER=kept$/m);
      expect(env).toMatch(/^PATH=/m);
      expect(env).not.toMatch(/^LOOM_PIECE_(HOME|NAME)=/m);
      expect(env).not.toMatch(/^TASKSTORE_/m);
      expect(env).toMatch(/^LOOM_HOME=\/the\/loom$/m);
    });

    it("a good answer draws the section; it's asked exactly cited-by <id> --json", () => {
      const seen = join(dir, "argv");
      const bin = script("good", `printf '%s ' "$@" > ${seen}; echo '${JSON.stringify([ref])}'`);
      expect(ids(run({ TASKSTORE_CHANGES: bin }))).toContain("changes");
      expect(readFileSync(seen, "utf8")).toBe("cited-by t-1 --json ");
    });

    it("absent, failing, slow, garbage or relative: exactly the page without it", () => {
      const without = ids(run({}));
      expect(without).not.toContain("changes");
      for (const bin of [join(dir, "missing"), script("fails", "exit 3"), script("garbage", "echo nope"), script("slow", `sleep 5; echo '${JSON.stringify([ref])}'`), "relative/loom-changes"]) {
        const t0 = Date.now();
        const r = run({ TASKSTORE_CHANGES: bin });
        expect(r.status, bin).toBe(0);
        expect(ids(r), bin).toEqual(without);
        expect(Date.now() - t0, bin).toBeLessThan(4000);
      }
    }, 30000);
  });
});
