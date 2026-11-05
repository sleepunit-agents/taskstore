// The tasks piece's side of a loom Comms thread (loom docs/specs/comms.md, "Work in this thread", criterion 24):
// --source and its LOOM_BODY_CONVERSATION default, the thread feed, the task page's from block, and the project
// feed taking the project's threads.
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, emptyState, type Command, type StoreState } from "../src/core.js";
import { parseThreadArgs, threadFeed } from "../src/thread-feed.js";
import { feed } from "../src/project-feed.js";
import { page, type UiView } from "../src/loom-ui.js";

const AT = "2026-11-05T12:00:00Z";
const CV = "cv-0123456789ab";
const OTHER = "cv-ba9876543210";

function state(ops: Array<Record<string, unknown>>): StoreState {
  let s = emptyState();
  for (const op of ops) {
    const r = apply(s, { actor: "art", at: AT, ...op } as Command);
    if (r.result.ok !== true) throw new Error(`${JSON.stringify(op)} -> ${JSON.stringify(r.result)}`);
    s = r.state;
  }
  return s;
}
const view = (s: StoreState) => ({ tasks: s.tasks, links: s.links, ready: [], owner: "jonathan" });
const at = (m: number) => `2026-11-05T12:${String(m).padStart(2, "0")}:00Z`;

describe("thread-feed (pure)", () => {
  const s = state([
    { op: "create", title: "Mentioned, open" },                                       // t-1
    { op: "create", title: "Made here, blocked", source: `conversation:${CV}` },     // t-2, blocked by t-1
    { op: "link", id: "t-2", dependsOn: "t-1", type: "blocks" },
    { op: "create", title: "Made elsewhere", source: `conversation:${OTHER}` },      // t-3
    { op: "create", title: "Yours", source: `conversation:${CV}` },                  // t-4
    { op: "update", id: "t-4", set: { assignee: "jonathan", ask: "Is it right?" } },
    { op: "create", title: "Done one" },                                              // t-5
    { op: "close", id: "t-5" },
  ]);
  const f = threadFeed(view(s), { conversation: CV, refs: ["t-1", "t-5", "t-99", "github:acme/app#3", "note:pond/plan"] });

  it("answers the tasks it names and the tasks made in it, in words, and nothing else", () => {
    expect(f.items.map((i) => [i.ref, i.status, i.tone ?? null, i.made ?? null, i.page])).toEqual([
      ["t-4", "Waiting on you", "warn", true, "task/t-4"],
      ["t-2", "Blocked", "bad", true, "task/t-2"],
      ["t-1", "Open", null, null, "task/t-1"],
      ["t-5", "Done", "ok", null, "task/t-5"],
    ]);
    expect(f.items.find((i) => i.ref === "t-1")!.title).toBe("Mentioned, open");
  });

  it("keeps loom's answer shape: known keys, ISO times, caps", () => {
    for (const i of f.items) {
      expect(Object.keys(i).every((k) => ["title", "ref", "status", "tone", "when", "page", "made"].includes(k))).toBe(true);
      expect(i.when).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(i.status.length).toBeLessThanOrEqual(24);
    }
    const many = state(Array.from({ length: 60 }, (_, n) => ({ op: "create", title: `m${n}`, source: `conversation:${CV}` })));
    expect(threadFeed(view(many), { conversation: CV, refs: [] }).items).toHaveLength(50);
  });

  it("when is closedAt, else startedAt, else createdAt; in progress reads so; an ask on an agent's task isn't yours", () => {
    let st = emptyState();
    const run = (op: Record<string, unknown>, m: number) => { st = apply(st, { actor: "art", at: at(m), ...op } as Command).state; };
    run({ op: "create", title: "opened", source: `conversation:${CV}` }, 1);            // t-1
    run({ op: "create", title: "started", source: `conversation:${CV}` }, 2);           // t-2
    run({ op: "claim", id: "t-2" }, 3);
    run({ op: "create", title: "finished", source: `conversation:${CV}` }, 4);          // t-3
    run({ op: "claim", id: "t-3" }, 5);
    run({ op: "close", id: "t-3" }, 6);
    run({ op: "create", title: "an agent's ask", source: `conversation:${CV}`, ask: "Go?" }, 7); // t-4, assigned to nobody
    const by = Object.fromEntries(threadFeed(view(st), { conversation: CV, refs: [] }).items.map((i) => [i.ref, i]));
    expect([by["t-1"].when, by["t-2"].when, by["t-3"].when]).toEqual([at(1), at(3), at(6)]);
    expect(by["t-2"].status).toBe("In progress");
    expect(by["t-4"].status).toBe("Open");
  });

  it("the owner's call says you only to the owner", () => {
    const owner = threadFeed(view(s), { conversation: CV, refs: [] }).items.find((i) => i.ref === "t-4")!;
    const sam = threadFeed({ ...view(s), viewer: "sam" }, { conversation: CV, refs: [] }).items.find((i) => i.ref === "t-4")!;
    expect([owner.status, sam.status]).toEqual(["Waiting on you", "Waiting on Jonathan"]);
  });

  it("a task both named and made is one item, made", () => {
    const f2 = threadFeed(view(s), { conversation: CV, refs: ["t-2", "t-2"] });
    expect(f2.items.filter((i) => i.ref === "t-2")).toEqual([expect.objectContaining({ made: true })]);
  });

  it("parses loom's argv and refuses anything else", () => {
    expect(parseThreadArgs(["--json", "--conversation", CV, "--ref", "t-1", "--ref", "t-2"])).toEqual({ conversation: CV, refs: ["t-1", "t-2"] });
    expect(parseThreadArgs(["--conversation", "cv-nope"])).toMatch(/conversation id/);
    expect(parseThreadArgs(["--conversation", CV, "--project", "p"])).toMatch(/unknown argument/);
    expect(parseThreadArgs(["--conversation", CV, ...Array.from({ length: 201 }, (_, i) => ["--ref", `t-${i}`]).flat()])).toMatch(/at most 200/);
  });

  it("the project feed takes the project's threads: a task made in one joins its section", () => {
    const g = feed({ ...view(s), ready: apply(s, { op: "ready" }).result.entries as never }, { project: "pond", since: AT, names: [], venues: [], conversations: [CV] });
    const refs = g.groups.flatMap((x) => x.items.map((i) => i.ref));
    expect(refs).toContain("t-2");
    expect(refs).toContain("t-4");
    expect(refs).not.toContain("t-3");
  });

  it("a task page carries the from block for a conversation source, and none without one", () => {
    const v: UiView = { ...view(s), now: new Date(AT) };
    const blocks = (id: string) => (page(v, { path: `task/${id}` }) as { sections: Array<{ id: string; blocks: Array<Record<string, unknown>> }> })
      .sections.flatMap((x) => x.blocks);
    expect(blocks("t-2")).toContainEqual({ type: "from", conversation: CV });
    expect(blocks("t-1").some((b) => b.type === "from")).toBe(false);
  });
});

describe("--source and LOOM_BODY_CONVERSATION (the CLI)", () => {
  const cli = join(__dirname, "..", "dist", "cli.js");
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TASKSTORE_") && k !== "LOOM_BODY_CONVERSATION"));
  let db = "";
  const run = (a: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [cli, ...a], { encoding: "utf8", env: { ...baseEnv, TASKSTORE_DB: db, ...extra } });
  const show = (id: string) => JSON.parse(run(["show", id]).stdout).task as Record<string, unknown>;
  const inThread = { LOOM_BODY_CONVERSATION: CV };

  beforeAll(() => { db = join(mkdtempSync(join(tmpdir(), "taskstore-source-")), "store.db"); });

  it("create --source holds it; a create in a conversation gets it from the environment; outside one, none", () => {
    expect(run(["create", "explicit", "--source", `conversation:${OTHER}`], inThread).status).toBe(0);  // t-1
    expect(run(["create", "from env"], inThread).status).toBe(0);                                     // t-2
    expect(run(["create", "plain"]).status).toBe(0);                                                  // t-3
    expect(show("t-1").source).toBe(`conversation:${OTHER}`);
    expect(show("t-2").source).toBe(`conversation:${CV}`);
    expect("source" in show("t-3")).toBe(false);
  });

  it("an update in a conversation sets it on a task without one and leaves one that has it", () => {
    expect(run(["update", "t-3", "--priority", "1"], inThread).status).toBe(0);
    expect(show("t-3").source).toBe(`conversation:${CV}`);
    expect(run(["update", "t-1", "--priority", "1"], inThread).status).toBe(0);
    expect(show("t-1").source).toBe(`conversation:${OTHER}`);
    expect(run(["update", "t-1", "--source", ""]).status).toBe(0);
    expect("source" in show("t-1")).toBe(false);
  });

  it("a malformed --source is refused, and thread-feed answers loom's argv", () => {
    const bad = run(["create", "x", "--source", "cv-0123456789ab"]);
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout).errors).toEqual(["E_BAD_FIELD"]);
    const before = readFileSync(db);
    const r = run(["thread-feed", "--json", "--conversation", CV, "--ref", "t-1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(db).equals(before)).toBe(true);
    expect(JSON.parse(r.stdout).items.map((i: { ref: string; made?: boolean }) => [i.ref, i.made ?? false])).toEqual([["t-3", true], ["t-2", true], ["t-1", false]]);
    expect(run(["thread-feed", "--json", "--conversation", "nope"]).status).toBe(2);
  });
});
