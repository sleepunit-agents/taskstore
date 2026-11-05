// One-off author for it-ts-source's fixtures (taskstore-core 0.7.0): each
// op-sequence's expected results are run through the core, then read by hand
// before they're committed. Prints fixture lines (canonical: compact JSON).
import { runOps } from "../src/run-ops.js";
import type { Command } from "../src/core.js";

const A = (m: number) => `2026-11-05T23:${String(m).padStart(2, "0")}:00Z`;
const fx = (id: string, description: string, ops: Command[]) => ({
  record: "fixture", id, contractId: "c-taskstore", description,
  expected: { results: runOps(ops) }, format: "taskstore/op-sequence@0", input: { ops },
});
const c = (o: Record<string, unknown>) => ({ actor: "art", ...o }) as Command;
const CV = "conversation:cv-0123456789ab";

const out = [
  fx("fx-source",
    "create holds source verbatim and show and export return it; an empty source on create is as if absent; update sets a source on a task without one, replaces one, and clears it with an empty string; list entries never carry it.",
    [
      c({ op: "create", title: "Fix the comm screen's frame", source: CV, at: A(1) }),
      c({ op: "create", title: "Tidy the dock", source: "", at: A(2) }),
      { op: "show", id: "$1" }, { op: "show", id: "$2" },
      c({ op: "update", id: "$2", set: { source: "conversation:cv-ba9876543210" }, at: A(3) }),
      c({ op: "update", id: "$1", set: { source: "wake:plan-night" }, at: A(4) }),
      { op: "show", id: "$1" },
      c({ op: "update", id: "$1", set: { source: "" }, at: A(5) }),
      { op: "show", id: "$1" }, { op: "list" }, { op: "ready" }, { op: "search", q: "ba9876543210" }, { op: "search", q: "dock" }, { op: "export" },
    ]),
  fx("fx-source-invalid",
    "a source that isn't a string, has no colon, an empty or 33-character kind, a kind starting with a digit or -, a capital, an empty or 201-character value, or a space or U+00A0 in the value is E_BAD_FIELD on create and update, changing nothing; a 32-character kind with digits and - and a 200-character value is held.",
    [
      c({ op: "create", title: "a", source: 7, at: A(1) }),
      c({ op: "create", title: "a", source: "cv-0123456789ab", at: A(2) }),
      c({ op: "create", title: "a", source: "conversation:cv one", at: A(3) }),
      c({ op: "create", title: "a", source: ":v", at: A(3) }),
      c({ op: "create", title: "a", source: `${"k".repeat(33)}:v`, at: A(3) }),
      c({ op: "create", title: "a", source: "9x:v", at: A(3) }),
      c({ op: "create", title: "a", source: "-x:v", at: A(3) }),
      c({ op: "create", title: "a", source: "conversation:", at: A(3) }),
      c({ op: "create", title: "a", source: `conversation:${"v".repeat(201)}`, at: A(3) }),
      c({ op: "create", title: "a", source: "conversation:cv\u00a0one", at: A(3) }),
      c({ op: "create", title: "b", at: A(4) }),
      c({ op: "update", id: "$1", set: { source: "Conversation:cv-0123456789ab" }, at: A(5) }),
      c({ op: "update", id: "$1", set: { source: ["x"] }, at: A(6) }),
      c({ op: "update", id: "$1", set: { source: "conversation:" }, at: A(6) }),
      c({ op: "create", title: "bounds", source: `${"k".repeat(29)}-9x:${"v".repeat(200)}`, at: A(7) }),
      { op: "export" },
    ]),
  fx("fx-source-import",
    "import holds a record's source verbatim and export returns it; an empty, malformed or non-string source is E_BAD_FIELD alone and imports nothing.",
    [
      c({ op: "import", at: A(1), tasks: [{ id: "legacy-1", title: "t", type: "task", status: "open", priority: 2, createdAt: A(0), createdBy: "art", comments: [], source: CV }] }),
      c({ op: "import", at: A(2), tasks: [{ id: "legacy-2", title: "t", type: "task", status: "open", priority: 2, createdAt: A(0), createdBy: "art", source: "" }] }),
      c({ op: "import", at: A(3), tasks: [{ id: "legacy-3", title: "t", type: "task", status: "open", priority: 2, createdAt: A(0), createdBy: "art", source: "no colon" }] }),
      c({ op: "import", at: A(4), tasks: [{ id: "legacy-4", title: "t", type: "task", status: "open", priority: 2, createdAt: A(0), createdBy: "art", source: 3 }] }),
      { op: "export" },
    ]),
];
for (const f of out) console.log(JSON.stringify(f));
