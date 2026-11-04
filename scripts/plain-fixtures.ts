// One-off author for it-ts-plain's fixtures (taskstore-core 0.5.0): each
// op-sequence's expected results are run through the core, then read by hand
// before they're committed. Prints fixture lines (canonical: compact JSON).
import { runOps } from "../src/run-ops.js";
import type { Command } from "../src/core.js";

const A = (m: number) => `2026-11-04T15:${String(m).padStart(2, "0")}:00Z`;
const fx = (id: string, description: string, ops: Command[]) => ({
  record: "fixture", id, contractId: "c-taskstore", description,
  expected: { results: runOps(ops) }, format: "taskstore/op-sequence@0", input: { ops },
});
const c = (o: Record<string, unknown>) => ({ actor: "art", ...o }) as Command;

const out = [
  fx("fx-plain-summary",
    "create holds goal, why and doneWhen verbatim; show returns them, list, search and ready carry goal; a task without them omits the keys; an empty string on create is as if absent.",
    [
      c({ op: "create", title: "Back up the photos offsite", goal: "Every photo has a copy off this machine.", why: "One disk failure would lose them all.", doneWhen: "A restore test from the offsite copy works.", at: A(1) }),
      c({ op: "create", title: "plain", goal: "", at: A(2) }),
      { op: "show", id: "$1" }, { op: "show", id: "$2" }, { op: "list" }, { op: "ready" }, { op: "search", q: "DISK FAILURE" },
    ]),
  fx("fx-plain-ask",
    "create with ask stamps askedBy from the command's actor; ifYes, ifNo and answers are held beside it; an update that sets a new ask restamps askedBy from its actor; show returns every field.",
    [
      c({ op: "create", title: "Plug in the backup drive", ask: "Can you plug the backup drive into the office machine?", ifYes: "I start the first backup tonight.", ifNo: "Backups stay on this machine.", answers: "yes-no", at: A(1) }),
      { op: "show", id: "$1" },
      c({ op: "update", id: "$1", actor: "mark", set: { ask: "Which drive should I use?", answers: "words" }, at: A(2) }),
      { op: "show", id: "$1" },
    ]),
  fx("fx-plain-ask-invalid",
    "ifYes, ifNo or answers with no ask is E_MISSING_FIELD on create and on an update of a task holding none; answers outside yes-no and words is E_BAD_FIELD; a plain field that isn't a string is E_BAD_FIELD; none of them changes the store.",
    [
      c({ op: "create", title: "a", ifYes: "go", at: A(1) }),
      c({ op: "create", title: "a", answers: "maybe", ask: "Go?", at: A(2) }),
      c({ op: "create", title: "a", goal: 7, at: A(3) }),
      c({ op: "create", title: "b", at: A(4) }),
      c({ op: "update", id: "$1", set: { ifNo: "stop" }, at: A(5) }),
      c({ op: "update", id: "$1", set: { ask: "Go?", answers: "maybe" }, at: A(6) }),
      c({ op: "update", id: "$1", set: { why: ["x"] }, at: A(7) }),
      { op: "export" },
    ]),
  fx("fx-plain-clear",
    "update with an empty string clears a plain field; clearing the ask clears ifYes, ifNo, answers and askedBy with it; replacing goal leaves why alone.",
    [
      c({ op: "create", title: "t", goal: "g1", why: "w", doneWhen: "d", ask: "Go?", ifYes: "y", ifNo: "n", answers: "yes-no", at: A(1) }),
      c({ op: "update", id: "$1", set: { goal: "g2", doneWhen: "" }, at: A(2) }),
      c({ op: "update", id: "$1", set: { ask: "" }, at: A(3) }),
      { op: "show", id: "$1" },
    ]),
  fx("fx-plain-import",
    "import holds the plain fields and askedBy verbatim and export returns them; a mistyped plain field or an answers outside its two words is E_BAD_FIELD and imports nothing.",
    [
      c({ op: "import", at: A(1), tasks: [{ id: "legacy-1", title: "t", type: "task", status: "open", priority: 2, createdAt: A(0), createdBy: "art", comments: [], goal: "g", why: "w", doneWhen: "d", ask: "Go?", ifYes: "y", ifNo: "n", answers: "words", askedBy: "mark" }] }),
      c({ op: "import", at: A(2), tasks: [{ id: "legacy-2", title: "t", type: "task", status: "open", priority: 2, createdAt: A(0), createdBy: "art", answers: "maybe" }] }),
      c({ op: "import", at: A(3), tasks: [{ id: "legacy-3", title: "t", type: "task", status: "open", priority: 2, createdAt: A(0), createdBy: "art", askedBy: 3 }] }),
      { op: "export" },
    ]),
];
for (const f of out) console.log(JSON.stringify(f));
