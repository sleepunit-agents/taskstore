// Builds spec/taskstore-core/{spec,fixtures}.jsonl in canonical felag
// interchange. Records are authored here as JS values; serialization,
// fixture sorting, and author-output validation all go through the felag
// library — never hand-formatted JSONL (ceremony rule).

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { serialize, sortFixtures, validateAuthorOutput } from "felag";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "spec", "taskstore-core");

// ---------------------------------------------------------------- preamble

const preamble = {
  record: "preamble",
  name: "taskstore-core",
  conformanceVersion: "0.1.0",
  goals: [
    "Carry exactly the working surface six months of agent-driven tracking actually used — ready queue, parent/child containers, priorities, claim/close lifecycle, comments, ad-hoc and spec-linked tasks — and refuse the junk drawer loudly.",
    "The core is one pure transition function over (state, command): the clock and the actor ride in the command, queries are the only observable, and every behavior is fixtured; storage, CLI, and scheduling live in bindings.",
    "The exit door is contract, not convention: lossless live export and identity-preserving import are fixture-carried MUSTs — the property the previous tracker's passive export promised and was probed not to hold (stale and lossy, 2026-06-12).",
    "Native felag-tasks support: linkage-idempotent create and the report projection make the c-tasks WorkLayer over this store mapping-only.",
  ],
  contracts: [
    {
      id: "c-taskstore",
      description:
        "The work-store transition contract: create/claim/close/reopen/update/comment/link mutations and show/list/ready/report/export/import windows, as pure transitions over (state, command) proven by op-sequence fixtures.",
    },
  ],
  exclusions: [
    "The loom boundary: memory, knowledge, identity, and prose-wiki surfaces belong to the owner's memory layer, never the work store. This contract offers no surface for them; a conforming store and its tooling add none (the judgment criterion ac-ts-loom-boundary carries the refusal).",
    "Storage engine and persistence: SQLite, WAL, file locations, and the write cadence of any passive on-disk export mirror are binding surface. The export CONTENT is contract (it-ts-portability); the file is not.",
    "CLI and MCP surface: verb spellings, flags, output formatting, trees, emoji, and human-facing rendering are binding surface; only the command/result values are contract.",
    "Sync, federation, remotes, and multi-writer concurrency: one store, one writer at a time; concurrent reads are the binding's business.",
    "Id generation scheme beyond the judgment criterion ac-ts-id-shape: random suffixes, dotted children, and sequences are implementation surface. Fixture corpora place caller-supplied ids in a 'legacy-' namespace and assume generated ids never collide with them; a generator emitting ids in that namespace fails those fixtures spuriously.",
    "Deferred, not refused (arrive as proposed criteria via promotion if wanted): defer/snooze and a deferred status, labels/tags, full-text search, stats and dashboards, stale/orphan hygiene tooling, batch mutations, task deletion, and re-alerting/notification of any kind.",
    "Automation around the store: hooks, timers, Discord delivery, audit-trail rendering of actor/at on mutations that do not stamp observable fields (update, comment metadata beyond the comment record, import's envelope actor/at) — recorded or not as the binding pleases; not observable here.",
    "Actor identity and authentication: actor is a free-form attribution string with no semantics (felag-tasks precedent).",
    "Import stamp cross-consistency: import validates identity, vocabulary, timestamps, and link structure; whether a closed record carries closedAt or an in_progress record carries startedAt is the exporter's business — records are held verbatim.",
    "felag-tasks conformance is proven by running the c-tasks fixture corpus over a WorkLayer projection of this store, not restated here; it-ts-create's linkage idempotency and it-ts-query's report op are the store-side support that makes that layer mapping-only.",
    "Residue: fractional and float-integer-lexeme priority values (2.5, 2.0) are normative in prose — a priority is its mathematical value, an integer 0..4, anything else E_BAD_PRIORITY — but structurally unfixturable in this interchange: felag CS6 canonicalization cannot carry the adversarial lexeme (watchdog-core precedent; felag finding art-ubo.4).",
  ],
  governance: { timeoutDays: 30 },
  implementers: [{ name: "taskstore project", roles: ["author", "maintainer", "repo-owner"] }],
};

// ------------------------------------------------------------------- items

const items = [];
const criteria = [];

function item(id, title, body, extra = {}) {
  items.push({ record: "item", id, title, body, ...extra });
}

function must(id, itemId, gherkin, fixtures) {
  criteria.push({
    record: "criterion", id, itemId, type: "scenario", class: "behavioral",
    gherkin, force: "MUST", state: "active", source: "forethought",
    contractId: "c-taskstore", fixtures: [...fixtures].sort(),
  });
}

function judgment(id, itemId, text) {
  criteria.push({
    record: "criterion", id, itemId, type: "checklist", class: "judgment",
    item: text, force: "MUST", state: "active", source: "forethought",
    contractId: "c-taskstore", fixtures: [],
  });
}

// -- it-ts-model -------------------------------------------------------------

item(
  "it-ts-model",
  "The store as pure transitions",
  `The taskstore core is one total transition function, apply: (state, command) -> (result, state). Every mutating command carries its own clock (at) and attribution (actor); the store never reads a wall clock and never invents attribution, so a command sequence determines every observable exactly. State is never exposed: the query commands — show, list, ready, report, export — are the only observable windows.

Wire format taskstore/op-sequence@0: input is {ops: [command, ...]}, executed in order against an initially empty store; expected is {results: [result, ...]}, one result per command, compared by structural JSON equality (key-order-independent) after id normalization. Id normalization: $k denotes the id generated by the k-th create command in the sequence that returns created true — $1 the first actual creation, $2 the second, counting neither failed creates nor idempotent hits. In command inputs a $-token resolves to that generated id before the command runs; a token or id string naming no held task reaches validation as an unknown referent, never as a parse error. In results, every generated id is rendered as its token; ids supplied by the caller (import) are literal in both inputs and results.

Ids are opaque strings, unique within one store against every id it has ever held — generated or imported — and never reused; beyond that and the judgment criterion ac-ts-id-shape, the generation scheme is the implementation's. actor is a free-form attribution string with no semantics.

Timestamps: every at-valued field is an RFC 3339 date-time, parseable exactly as felag-core it-verification's Timestamps rule defines (numeric offset or Z required, T and Z case-insensitive, second 60 excluded) — that rule is incorporated by reference, not restated. A required timestamp field that is absent or not a string is E_MISSING_FIELD; a string that does not parse is E_BAD_TIMESTAMP. Accepted timestamps are stored and returned VERBATIM: this contract never normalizes to UTC and never orders anything by timestamp value — every ordering it defines is submission or creation order — so offset spelling can never change observable output beyond the verbatim field itself.

Results are envelopes with exact key sets. Every result carries ok (boolean) and errors (array); create adds created and id; show adds task; list, ready, and report add entries; export adds tasks and links; import adds imported. On error the payload fields hold neutral values: id null, created false, task null, entries [], imported 0 (export takes no arguments and cannot error, so tasks and links have no error case). errors is a sorted set — ascending code-point order, deduplicated — and validation is all-applicable, never short-circuiting: every well-posed check reports its code. Well-posedness: field-validity checks (presence, type, vocabulary, timestamp parse) are always well-posed and co-fire. Referent-existence checks are well-posed over STRING-valued referent fields only, and then co-fire: a referent field that fails its type check reports its type error (E_BAD_FIELD, or E_MISSING_FIELD when required) alone — no existence lookup happens on a non-string, so a numeric parent never adds E_UNKNOWN_ID. Checks that interrogate an existing referent — transition legality, cycle detection, parent uniqueness, duplicate-link detection, linkage idempotency — are gated ONLY by what they interrogate: each evaluates whenever its referents exist (and, for link's graph checks, whenever the type names a known graph), and CO-FIRES with any field errors elsewhere in the command. An unparseable at never suppresses E_BAD_TRANSITION on a known referent; an unknown referent suppresses exactly the checks that needed it. A command reporting any error changes nothing: per-command atomicity. Field-validity rules shared by every command: a required field absent or not of its declared type is E_MISSING_FIELD; an optional field present but not of its declared type is E_BAD_FIELD, except type (E_BAD_TYPE) and priority (E_BAD_PRIORITY), which carry their own codes wherever they appear. Error codes at 0.1.0: E_BAD_FIELD, E_BAD_PRIORITY, E_BAD_TIMESTAMP, E_BAD_TRANSITION, E_BAD_TYPE, E_CYCLE, E_DUP_ID, E_DUP_LINKAGE, E_HAS_PARENT, E_MISSING_FIELD, E_UNKNOWN_ID.

The store holds work tracking only: memory, knowledge, and identity live in the owner's memory layer, and this contract deliberately offers no surface for them — the boundary that is not enforced is the boundary that erodes (see the exclusions and ac-ts-loom-boundary).`,
  {
    interfaceSketch:
      "apply(state: StoreState, command: Command): {result: Result, state: StoreState} — pure, total, no I/O; op-sequence runner folds apply over ops and normalizes generated ids to $-tokens.",
  },
);

must(
  "ac-ts-errors-all-applicable",
  "it-ts-model",
  "Given a command violating several independent field-validity and referent-existence rules at once\nWhen it runs\nThen errors carries every applicable code exactly once, sorted ascending — never just the first failure — and the store is unchanged",
  ["fx-errors-all", "fx-link-invalid"],
);
must(
  "ac-ts-timestamps",
  "it-ts-model",
  "Given commands whose at is a parseable RFC 3339 instant with a non-Z offset, an offsetless date-time, and a leap-second date-time\nWhen they run\nThen the offset timestamp is accepted and returned verbatim — never normalized to UTC — and the offsetless and leap-second forms are rejected with E_BAD_TIMESTAMP, creating nothing",
  ["fx-timestamp-bad", "fx-timestamp-verbatim"],
);
must(
  "ac-ts-normalization",
  "it-ts-model",
  "Given a sequence where failed creates and an idempotent hit precede later successful creates\nWhen results are normalized\nThen $k counts only creates that actually created — the first success after two failures is $1, and the create after an idempotent hit takes the next token, not the command index",
  ["fx-linkage-idempotent", "fx-timestamp-bad"],
);
judgment(
  "ac-ts-id-shape",
  "it-ts-model",
  "Generated ids are stable short strings in a recognizable store-prefix form (prefix-suffix, art-xxx style), opaque to every consumer, unique against every id the store has ever held, and never reused; the generation scheme itself — random suffix, dotted child, sequence — is the implementation's business.",
);
judgment(
  "ac-ts-loom-boundary",
  "it-ts-model",
  "The store holds work-tracking records only: it offers no memory, knowledge, identity, or prose-wiki surface, and tooling built over it adds none. Episodic memory and facts about the world belong to the owner's memory layer (loom, here); work records cite them by reference — [[slug]], paths, URLs — instead of absorbing them.",
);

// -- it-ts-create ------------------------------------------------------------

item(
  "it-ts-create",
  "create — intake, defaults, and spec linkage",
  `create takes {title, actor, at, description?, type?, priority?, parent?, specItemRef?, criterionId?, legacyRef?} and returns {ok, errors, created, id}. Required: title, actor, at — strings (absent or mistyped: E_MISSING_FIELD; unparseable at: E_BAD_TIMESTAMP per it-ts-model). Optional string fields (description, parent, specItemRef, criterionId, legacyRef) present but non-string: E_BAD_FIELD.

Defaults and vocabulary: type defaults to task; the vocabulary is task | bug | feature | epic, anything else E_BAD_TYPE. priority defaults to 2; a valid priority is an integer 0..4 by mathematical value, not lexeme — fractional, negative, out-of-range, or non-numeric values are E_BAD_PRIORITY (the fractional lexeme is unfixturable residue; see the exclusions). Only epic carries contract semantics elsewhere (it-ts-ready); types are otherwise labels.

A successful create stores the task with status open, createdAt = at (verbatim), createdBy = actor, the given fields, and a fresh id (created true). parent, when present, must name a held task (else E_UNKNOWN_ID, co-firing with any field errors); on success the parent-child edge (id depends on parent) is created atomically with the task, exactly as if link had run — a fresh task has no prior parent and cannot complete a cycle, so no link-side code can arise. legacyRef is preserved verbatim wherever the task renders (show, export).

Spec linkage: specItemRef (by convention 'spec:<specName>/<itemId>') with optional criterionId. criterionId without specItemRef is E_MISSING_FIELD. Linkage idempotency — the c-tasks rule, native: tasks are keyed on (specItemRef, criterionId), absent criterionId a distinct key value. VALIDATION PRECEDES IDEMPOTENCY: a create reporting any error — field or referent, an unknown parent included — does nothing and returns the error envelope (id null), even when its linkage key is held. A create that validates clean and whose key is already held is a HIT: it returns ok true, created false, and the EXISTING task's id, whatever that task's status — open, claimed, or closed — and changes nothing: the title, the parent (no edge is created), and every other field of the proposal are discarded whole. Creates with no specItemRef carry no key and never collide. Distinct criterionIds under one specItemRef are distinct tasks.`,
);

must(
  "ac-ts-create-defaults",
  "it-ts-create",
  "Given a create carrying only title, actor, and at, and another carrying description, type bug, and priority 0\nWhen each runs and is shown\nThen the first holds type task, priority 2, status open, createdAt/createdBy from the command, and no description key\nAnd the second holds exactly the fields it was given",
  ["fx-create-defaults"],
);
must(
  "ac-ts-create-parent",
  "it-ts-create",
  "Given a create naming a held task as parent and another naming an unknown id\nWhen they run\nThen the first creates the task and the parent-child edge atomically — visible as parent in show and as a links entry in export\nAnd the second reports E_UNKNOWN_ID and creates nothing",
  ["fx-create-bad-parent", "fx-create-parent"],
);
must(
  "ac-ts-create-validate",
  "it-ts-create",
  "Given creates with actor absent or numeric, a present-but-mistyped required field (a numeric title; a numeric at), a criterionId without specItemRef, mistyped optional fields (parent, legacyRef, specItemRef, criterionId), priorities of -1 and \"high\", and a boundary priority 4\nWhen they run\nThen the absent or mistyped required fields and the lone criterionId report E_MISSING_FIELD (co-firing with other field errors), mistyped optionals report E_BAD_FIELD with NO existence lookup on a non-string referent, the bad priorities report E_BAD_PRIORITY, the boundary 4 is accepted, and nothing failed is created",
  ["fx-create-invalid"],
);
must(
  "ac-ts-linkage-idempotent",
  "it-ts-create",
  "Given tasks held for a (specItemRef, criterionId) key in each status — open, in_progress, closed\nWhen the same key is created again with a different title, with a known parent, and with an unknown parent\nThen the clean re-creates return ok with created false and the existing id whatever the status, the holder's fields survive and NO parent edge is created (the colliding proposal is discarded whole), the unknown-parent create fails E_UNKNOWN_ID with id null (validation precedes idempotency), and report still lists exactly one entry per key",
  ["fx-linkage-idempotent", "fx-linkage-parent"],
);
must(
  "ac-ts-linkage-distinct",
  "it-ts-create",
  "Given creates for one specItemRef under criterionId A, criterionId B, and no criterionId\nWhen report runs\nThen three distinct tasks exist, the keyless entry sorting before any criterion-bearing one",
  ["fx-linkage-distinct"],
);

// -- it-ts-lifecycle ---------------------------------------------------------

item(
  "it-ts-lifecycle",
  "claim, close, reopen — the status walk",
  `The stored status vocabulary is exactly open | in_progress | closed. blocked is never stored — it is a view derived from links (it-ts-ready) — and there is no deferred at 0.1.0 (excluded, deferred-not-refused).

claim {id, actor, at}: requires status open; sets status in_progress, assignee = actor, startedAt = at. close {id, actor, at, reason?}: requires status open or in_progress; sets status closed, closedAt = at, and closeReason = reason when present (reason optional string; E_BAD_FIELD when present non-string); fields stamped by an earlier claim survive. reopen {id, actor, at}: requires status closed; returns the task to open and REMOVES startedAt, assignee, closedAt, and closeReason — the claim and close stamps do not survive a reopen; history that matters belongs in comments.

A lifecycle command whose target's status is outside its requirement reports E_BAD_TRANSITION: claiming a task already in_progress or closed, closing a closed task, reopening anything not closed. Per it-ts-model, E_BAD_TRANSITION is a referent-interrogating check: it co-fires with field errors (a bad at and a bad transition both report) but is not evaluated when the id is unknown — E_UNKNOWN_ID reports alone with the field errors. A failed lifecycle command changes nothing: stamps and status hold their prior values exactly.`,
);

must(
  "ac-ts-claim",
  "it-ts-lifecycle",
  "Given an open task\nWhen claim runs\nThen the task is in_progress with assignee = the command's actor and startedAt = the command's at, verbatim",
  ["fx-claim"],
);
must(
  "ac-ts-close",
  "it-ts-lifecycle",
  "Given a claimed task and a separate never-claimed open task\nWhen close runs on each, once with a reason and once without\nThen both are closed with closedAt stamped; the reasoned close carries closeReason and the claim stamps survive; the unreasoned close carries no closeReason key",
  ["fx-close"],
);
must(
  "ac-ts-reopen",
  "it-ts-lifecycle",
  "Given a task that was claimed then closed with a reason\nWhen reopen runs\nThen the task is open with startedAt, assignee, closedAt, and closeReason all absent\nAnd a second reopen reports E_BAD_TRANSITION",
  ["fx-reopen"],
);
must(
  "ac-ts-lifecycle-guard",
  "it-ts-lifecycle",
  "Given lifecycle commands whose targets are in the wrong status — re-claiming in_progress, claiming closed, closing closed, reopening in_progress — or unknown (literal or unresolved $-token), or addressed with invalid fields\nWhen they run\nThen wrong-status targets report E_BAD_TRANSITION, which CO-FIRES with field errors on a known target (a non-string reason and an offsetless at report alongside it) but never fires on an unknown id, and every failed command leaves status and stamps exactly as they were",
  ["fx-claim-bad", "fx-close-closed"],
);

// -- it-ts-ready -------------------------------------------------------------

item(
  "it-ts-ready",
  "ready — the work queue",
  `ready takes no arguments and returns {ok, errors, entries}: every task that is workable now. A task is ready iff its status is open AND its type is not epic AND it has no unsatisfied blocker, where a blocker is unsatisfied iff the task holds a blocks edge whose dependsOn target's status is anything other than closed. So: in_progress tasks are taken, closed tasks are done, epics are containers — none appear; a blocker that is merely claimed (in_progress) still blocks; closing the blocker releases. parent-child edges NEVER gate readiness: children of open containers are workable, and a non-epic parent is itself workable alongside its children. The epic exclusion is a deliberate divergence from the brownfield predecessor, whose queue surfaced containers as noise (probed 2026-06-12).

Order: priority ascending (0 first), ties by creation order ascending — the order tasks entered the store, which the op sequence fully determines. Never by id (opaque, implementation-varying) and never by timestamp (it-ts-model). Entry shape, exactly: {id, priority, title, type}.`,
);

must(
  "ac-ts-ready-sort",
  "it-ts-ready",
  "Given open tasks with mixed priorities whose at timestamps deliberately disagree with their creation order\nWhen ready runs\nThen entries are sorted by priority ascending, ties broken by creation order ascending — a createdAt-ordered or id-ordered queue diverges and does not conform",
  ["fx-ready-sort"],
);
must(
  "ac-ts-ready-excludes",
  "it-ts-ready",
  "Given an epic (even at priority 0), an in_progress task, and a closed task alongside an open task\nWhen ready runs\nThen only the open non-epic task appears",
  ["fx-ready-epic", "fx-ready-status"],
);
must(
  "ac-ts-ready-blocked",
  "it-ts-ready",
  "Given a task with a blocks edge to an open blocker\nWhen ready runs before the blocker closes, after the blocker is merely claimed, and after the blocker closes\nThen the dependent is absent while the blocker is open, still absent while the blocker is in_progress, and present once the blocker is closed",
  ["fx-ready-block", "fx-ready-unblock"],
);
must(
  "ac-ts-ready-parent",
  "it-ts-ready",
  "Given a non-epic task with a child linked parent-child\nWhen ready runs\nThen both parent and child appear — parent-child edges never gate readiness",
  ["fx-ready-parent"],
);

// -- it-ts-links -------------------------------------------------------------

item(
  "it-ts-links",
  "link — typed dependencies",
  `link {id, dependsOn, type, actor, at} records that task id depends on task dependsOn. Types: blocks | parent-child; anything else E_BAD_TYPE. Both id and dependsOn must name held tasks; unknown referents report E_UNKNOWN_ID — errors being a set, one code however many referents are unknown.

The two types form SEPARATE directed graphs. A link whose addition would create a directed cycle within its own type's graph — including the self-link, a 1-cycle — reports E_CYCLE; an edge in one graph never contributes to a cycle in the other (a blocks edge a->b coexists with a parent-child edge b->a). parent-child additionally keeps a forest: a task already holding a parent-child edge to some parent refuses a parent-child edge to a DIFFERENT parent with E_HAS_PARENT.

A link identical to one already held — same (id, dependsOn, type) triple — is accepted with ok true and changes nothing: no duplicate edge appears anywhere. Duplicate detection precedes the parent-uniqueness and cycle checks: re-linking the identical parent edge is a no-op, never E_HAS_PARENT. Edges render in three places: show renders a task's blocks targets as dependsOn in edge-creation order and its parent-child target as parent; export renders every edge in creation order as {dependsOn, id, type} (it-ts-portability). There is no unlink at 0.1.0 (excluded, deferred-not-refused).`,
);

must(
  "ac-ts-link",
  "it-ts-links",
  "Given a task linked blocks to two targets in an order that disagrees with id order\nWhen show and export run\nThen show lists dependsOn in edge-creation order — never id order — and export carries every edge as {dependsOn, id, type} in creation order",
  ["fx-link"],
);
must(
  "ac-ts-link-cycle",
  "it-ts-links",
  "Given a chain of blocks edges, a self-link attempt, and parent-child edges over the same tasks\nWhen links that would close a directed cycle within one type's graph are attempted\nThen each reports E_CYCLE, while an edge that is acyclic within its own graph is accepted even when the OTHER graph holds the reverse edge",
  ["fx-link-cycle"],
);
must(
  "ac-ts-link-parent-unique",
  "it-ts-links",
  "Given a task with a parent\nWhen a parent-child link to a different parent is attempted\nThen it reports E_HAS_PARENT and show still names the original parent",
  ["fx-link-parent"],
);
must(
  "ac-ts-link-idempotent",
  "it-ts-links",
  "Given a held blocks edge and a held parent-child edge\nWhen each identical link is submitted again\nThen both are accepted ok and nothing changes — one edge each in show and export, and the repeated parent edge is a no-op, never E_HAS_PARENT",
  ["fx-link-dup"],
);
must(
  "ac-ts-link-validate",
  "it-ts-links",
  "Given links naming unknown referents and an unknown type\nWhen they run\nThen unknown referents report E_UNKNOWN_ID once however many are unknown, an unknown type co-fires E_BAD_TYPE, and no edge is recorded",
  ["fx-link-invalid"],
);

// -- it-ts-annotate ----------------------------------------------------------

item(
  "it-ts-annotate",
  "comment and update — annotation without lifecycle",
  `comment {id, text, actor, at}: text is a required string; a successful comment appends {actor, at, text} to the task's comments. Comments render everywhere in SUBMISSION order, never re-sorted by at: a comment carrying an earlier clock than its predecessor still renders after it — clock skew must not rewrite history (it-ts-model orders nothing by timestamp).

update {id, set, actor, at}: set is a JSON object carrying at least one of exactly title, description, priority, assignee. set absent, not an object, or empty: E_MISSING_FIELD. Any other key in set: E_BAD_FIELD. Values validate as create does — priority an integer 0..4 by value (E_BAD_PRIORITY), the string fields strings (E_BAD_FIELD). A successful update replaces exactly the named fields. update never touches status or any stamp (createdAt, createdBy, startedAt, closedAt, closeReason), and it works on a task of ANY status — annotating closed work is normal operation (close reasons get amended after the fact). Neither comment nor update affects readiness, linkage, or lifecycle.`,
);

must(
  "ac-ts-comment",
  "it-ts-annotate",
  "Given a task and two comments, the second carrying an at EARLIER than the first's\nWhen show runs\nThen comments render in submission order — the later-submitted, earlier-stamped comment last — with actor, at, and text verbatim",
  ["fx-comment-order"],
);
must(
  "ac-ts-comment-validate",
  "it-ts-annotate",
  "Given a comment naming an unknown id and a comment missing text\nWhen they run\nThen they report E_UNKNOWN_ID and E_MISSING_FIELD respectively and no comment is recorded",
  ["fx-comment-invalid"],
);
must(
  "ac-ts-update",
  "it-ts-annotate",
  "Given an open task\nWhen update sets title, description, priority, and assignee, the task is closed, and a further update amends description\nThen every named field holds its newest value, the update on the closed task succeeds, and status and stamps are exactly what the lifecycle commands set",
  ["fx-update"],
);
must(
  "ac-ts-update-validate",
  "it-ts-annotate",
  "Given updates with an empty set, a set naming status, and a set carrying an out-of-range priority and a non-string title\nWhen they run\nThen they report E_MISSING_FIELD, E_BAD_FIELD, and the sorted pair E_BAD_FIELD + E_BAD_PRIORITY respectively, and the task is unchanged",
  ["fx-update-invalid"],
);

// -- it-ts-query -------------------------------------------------------------

item(
  "it-ts-query",
  "show, list, report — the windows",
  `show {id}: the task's full record, or E_UNKNOWN_ID with task null. The record's key set is exactly: always {comments, createdAt, createdBy, dependsOn, id, priority, status, title, type}; plus each of assignee, closeReason, closedAt, criterionId, description, legacyRef, parent, specItemRef, startedAt exactly when held — absence is key-absence, never null. comments in submission order (it-ts-annotate); dependsOn is the task's blocks targets in edge-creation order, [] when none; parent is the parent-child target when one is held.

list {status?}: entries for tasks in creation order — the order they entered the store, imports included (it-ts-portability). Entry shape: {id, priority, status, title, type}, plus parent exactly when held. The status filter, when present, must be one of open | in_progress | closed (else E_BAD_FIELD with entries []) and restricts entries to tasks of that status. No filter means every task, whatever its status.

report: the c-tasks projection, natively. Entries for every spec-linked task — every task holding a specItemRef — with shape {criterionId?, specItemRef, status, taskRef} where taskRef is the task's id, sorted ascending by (specItemRef, criterionId, taskRef) with absent criterionId before any present value (under linkage uniqueness the taskRef key is never decisive — two spec-linked tasks cannot share a (specItemRef, criterionId) key, absent criterionId being a key value; the tertiary key is retained verbatim for c-tasks alignment). Status mapping: open -> open; in_progress -> in_progress; closed -> done, EXCEPT closed with closeReason exactly "cancelled" — full-string, case-sensitive — which maps to cancelled. Tasks without specItemRef never appear. This projection is the store-side half of felag-tasks conformance: a WorkLayer over this store maps propose to create, transition-to-cancelled to close with reason "cancelled", and report to report.`,
);

must(
  "ac-ts-show",
  "it-ts-query",
  "Given a task created with every optional field and an unknown id\nWhen show runs on each\nThen the task renders with exactly the held keys — absent optionals omitted, never null — and the unknown id reports E_UNKNOWN_ID with task null",
  ["fx-show"],
);
must(
  "ac-ts-list",
  "it-ts-query",
  "Given tasks in each status\nWhen list runs unfiltered, filtered to open, and filtered to a value outside the vocabulary\nThen unfiltered lists every task in creation order with statuses shown, the open filter restricts to open tasks, and the bad filter reports E_BAD_FIELD with no entries",
  ["fx-list"],
);
must(
  "ac-ts-report",
  "it-ts-query",
  "Given spec-linked tasks across two specItemRefs, one keyless and one claimed, alongside an ad-hoc task\nWhen report runs\nThen only spec-linked tasks appear, sorted by (specItemRef, criterionId, taskRef) with the keyless entry first, statuses projected to the c-tasks vocabulary",
  ["fx-report"],
);
must(
  "ac-ts-report-cancelled",
  "it-ts-query",
  "Given closed spec-linked tasks with closeReason \"cancelled\", \"shipped\", and \"Cancelled\"\nWhen report runs\nThen exactly the lowercase-\"cancelled\" task projects to cancelled and the others project to done — the match is full-string and case-sensitive",
  ["fx-report-cancelled"],
);

// -- it-ts-portability -------------------------------------------------------

item(
  "it-ts-portability",
  "export and import — the exit door",
  `export takes no arguments and returns {ok, errors, tasks, links}: the store's complete observable content. tasks holds every held task in creation order, each in the show shape MINUS the derived keys parent and dependsOn — edges live once, in links — with comments always present ([] when none) and every other optional key exactly when held. links holds every edge in creation order, shape {dependsOn, id, type}. Export is total and live: every contract field a task holds appears, every time. An export that summarizes, truncates, or lags the store does not conform — the brownfield motivation for this contract: the predecessor's passive export was probed stale (24 of 45 issues) and lossy (no descriptions) on 2026-06-12.

import {tasks, links?, actor, at} accepts export-shaped content. Required per task record: createdAt, createdBy, id, priority, status, title, type (absent or mistyped: E_MISSING_FIELD). Vocabulary and validity: type per create (E_BAD_TYPE); status one of open | in_progress | closed (E_BAD_FIELD); priority an integer 0..4 (E_BAD_PRIORITY); every timestamp field present — createdAt, startedAt, closedAt, comment ats — parseable (E_BAD_TIMESTAMP). Optionals as create accepts, plus assignee, startedAt, closedAt, closeReason, and comments ([{actor, at, text}], each field a required string). A task record carrying parent or dependsOn keys is E_BAD_FIELD — edges arrive only via links. Id collisions — within the payload or against any held id — report E_DUP_ID; linkage-key collisions (it-ts-create) likewise E_DUP_LINKAGE. links entries validate exactly as link does, over the union of held and payload ids. Stamp cross-consistency is NOT validated: whether a closed record carries closedAt is the exporter's business (see the exclusions); records are held verbatim.

Import is ATOMIC: any error anywhere in the payload reports the full sorted error set with imported 0 and the store unchanged. On success, imported is the number of task records, ids are held literally — never regenerated — legacyRef and every field survive verbatim, and creation order extends by payload order. Round trip: importing an export into an empty store and exporting again yields the imported records exactly.`,
);

must(
  "ac-ts-export-lossless",
  "it-ts-portability",
  "Given a task carrying every optional field, a claim, and a comment, alongside a plain task and a blocks edge\nWhen export runs\nThen every held field of every task appears verbatim in creation order and the edge appears in links — nothing summarized, nothing dropped",
  ["fx-export"],
);
must(
  "ac-ts-import",
  "it-ts-portability",
  "Given an import of export-shaped records with literal legacy ids, stamps, comments, and a parent-child link\nWhen it runs and the store is queried\nThen the records are held verbatim under their literal ids — stamps, comments, legacyRef, and the edge intact — and subsequent creates take creation-order positions after them",
  ["fx-import"],
);
must(
  "ac-ts-import-atomic",
  "it-ts-portability",
  "Given imports whose payloads collide with held ids and linkage keys, repeat ids internally, violate vocabulary and timestamp rules, omit required fields, carry forbidden parent keys, or link unknown referents\nWhen they run\nThen every applicable code reports in one sorted set with imported 0 and the store holds exactly what it held before — per-record validation is not optional",
  ["fx-import-dup", "fx-import-invalid"],
);
must(
  "ac-ts-roundtrip",
  "it-ts-portability",
  "Given an empty store\nWhen an export-shaped payload is imported and export runs\nThen the exported tasks and links equal the imported payload exactly — the exit door is lossless in both directions",
  ["fx-roundtrip"],
);

// ---------------------------------------------------------------- fixtures

const A = "art";
const T0 = "2026-06-12T18:00:00Z";
const T1 = "2026-06-12T18:05:00Z";
const T2 = "2026-06-12T18:10:00Z";
const T3 = "2026-06-12T18:15:00Z";
const T4 = "2026-06-12T18:20:00Z";
const T5 = "2026-06-12T18:25:00Z";

const FORMAT = "taskstore/op-sequence@0";

const createOK = (id, created = true) => ({ created, errors: [], id, ok: true });
const createErr = (errors) => ({ created: false, errors, id: null, ok: false });
const actOK = { errors: [], ok: true };
const actErr = (errors) => ({ errors, ok: false });
const showOK = (task) => ({ errors: [], ok: true, task });
const showErr = { errors: ["E_UNKNOWN_ID"], ok: false, task: null };
const entriesOK = (entries) => ({ entries, errors: [], ok: true });
const entriesErr = (errors) => ({ entries: [], errors, ok: false });
const exportOK = (tasks, links) => ({ errors: [], links, ok: true, tasks });
const importOK = (imported) => ({ errors: [], imported, ok: true });
const importErr = (errors) => ({ errors, imported: 0, ok: false });

// show-shaped task with defaults; pass overrides/extras.
const task = (over) => ({
  comments: [], createdAt: T0, createdBy: A, dependsOn: [],
  priority: 2, status: "open", type: "task", ...over,
});
// export-shaped task: no dependsOn/parent keys.
const exTask = (over) => {
  const t = task(over);
  delete t.dependsOn;
  delete t.parent;
  return t;
};

const fixtures = [];
function fx(id, description, ops, results) {
  fixtures.push({
    record: "fixture", id, contractId: "c-taskstore", description,
    format: FORMAT, input: { ops }, expected: { results },
  });
}

// -- model

fx(
  "fx-errors-all",
  "A create violating four independent rules at once — missing title, mistyped description, unknown type, out-of-range priority — reports all four codes sorted, and the store is unchanged.",
  [
    { op: "create", actor: A, at: T0, description: 42, priority: 9, type: "saga" },
    { op: "list" },
  ],
  [
    createErr(["E_BAD_FIELD", "E_BAD_PRIORITY", "E_BAD_TYPE", "E_MISSING_FIELD"]),
    entriesOK([]),
  ],
);

fx(
  "fx-timestamp-verbatim",
  "An accepted non-Z offset timestamp and lowercase t/z designators are stored and returned verbatim, never normalized or upcased.",
  [
    { op: "create", actor: A, at: "2026-06-12T13:00:00-05:00", title: "offset task" },
    { op: "show", id: "$1" },
    { op: "create", actor: A, at: "2026-06-12t20:00:00z", title: "lowercase designators" },
    { op: "show", id: "$2" },
  ],
  [
    createOK("$1"),
    showOK(task({ createdAt: "2026-06-12T13:00:00-05:00", id: "$1", title: "offset task" })),
    createOK("$2"),
    showOK(task({ createdAt: "2026-06-12t20:00:00z", id: "$2", title: "lowercase designators" })),
  ],
);

fx(
  "fx-timestamp-bad",
  "An offsetless date-time and a leap-second date-time are both unparseable per the felag-core Timestamps rule: E_BAD_TIMESTAMP, nothing created — and the success that follows two failures normalizes to $1, not $3.",
  [
    { op: "create", actor: A, at: "2026-06-12T18:00:00", title: "no offset" },
    { op: "create", actor: A, at: "2026-06-30T23:59:60Z", title: "leap second" },
    { op: "create", actor: A, at: T0, title: "after the failures" },
    { op: "show", id: "$1" },
  ],
  [
    createErr(["E_BAD_TIMESTAMP"]),
    createErr(["E_BAD_TIMESTAMP"]),
    createOK("$1"),
    showOK(task({ id: "$1", title: "after the failures" })),
  ],
);

// -- create

fx(
  "fx-create-defaults",
  "A minimal create takes type task, priority 2, status open, stamps from the command, and no absent-field keys; an explicit create holds exactly what it was given.",
  [
    { op: "create", actor: A, at: T0, title: "plain" },
    { op: "show", id: "$1" },
    { op: "create", actor: A, at: T1, description: "boom on deploy", priority: 0, title: "urgent bug", type: "bug" },
    { op: "show", id: "$2" },
  ],
  [
    createOK("$1"),
    showOK(task({ id: "$1", title: "plain" })),
    createOK("$2"),
    showOK(task({ createdAt: T1, description: "boom on deploy", id: "$2", priority: 0, title: "urgent bug", type: "bug" })),
  ],
);

fx(
  "fx-create-parent",
  "create with parent creates the task and the parent-child edge atomically: parent in show, edge in export.",
  [
    { op: "create", actor: A, at: T0, priority: 1, title: "the epic", type: "epic" },
    { op: "create", actor: A, at: T1, parent: "$1", title: "first child" },
    { op: "show", id: "$2" },
    { op: "export" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    showOK(task({ createdAt: T1, id: "$2", parent: "$1", title: "first child" })),
    exportOK(
      [
        exTask({ id: "$1", priority: 1, title: "the epic", type: "epic" }),
        exTask({ createdAt: T1, id: "$2", title: "first child" }),
      ],
      [{ dependsOn: "$1", id: "$2", type: "parent-child" }],
    ),
  ],
);

fx(
  "fx-create-bad-parent",
  "create naming an unknown parent reports E_UNKNOWN_ID — co-fired with field errors when both hold — and creates nothing.",
  [
    { op: "create", actor: A, at: T0, parent: "legacy-nope", title: "orphan" },
    { op: "create", actor: A, at: T1, parent: "legacy-nope", priority: 9, title: "orphan two" },
    { op: "list" },
  ],
  [createErr(["E_UNKNOWN_ID"]), createErr(["E_BAD_PRIORITY", "E_UNKNOWN_ID"]), entriesOK([])],
);

fx(
  "fx-create-invalid",
  "Absent and mistyped actor, present-but-mistyped required fields, and a lone criterionId are E_MISSING_FIELD; mistyped optionals are E_BAD_FIELD with no existence lookup on the numeric parent; -1 and \"high\" are E_BAD_PRIORITY; the boundary priority 4 is accepted.",
  [
    { op: "create", actor: A, at: T0, title: 9 },
    { op: "create", actor: A, at: 42, title: "numeric clock" },
    { op: "create", at: T0, title: "nobody claims this" },
    { op: "create", actor: 42, at: T0, priority: 9, title: "numeric actor" },
    { op: "create", actor: A, at: T0, criterionId: "ac1", title: "lone criterion" },
    { op: "create", actor: A, at: T0, legacyRef: 7, parent: 42, title: "mistyped optionals" },
    { op: "create", actor: A, at: T0, criterionId: true, specItemRef: 5, title: "mistyped linkage" },
    { op: "create", actor: A, at: T0, priority: -1, title: "below range" },
    { op: "create", actor: A, at: T0, priority: "high", title: "named priority" },
    { op: "create", actor: A, at: T1, priority: 4, title: "boundary" },
    { op: "list" },
  ],
  [
    createErr(["E_MISSING_FIELD"]),
    createErr(["E_MISSING_FIELD"]),
    createErr(["E_MISSING_FIELD"]),
    createErr(["E_BAD_PRIORITY", "E_MISSING_FIELD"]),
    createErr(["E_MISSING_FIELD"]),
    createErr(["E_BAD_FIELD"]),
    createErr(["E_BAD_FIELD"]),
    createErr(["E_BAD_PRIORITY"]),
    createErr(["E_BAD_PRIORITY"]),
    createOK("$1"),
    entriesOK([{ id: "$1", priority: 4, status: "open", title: "boundary", type: "task" }]),
  ],
);

fx(
  "fx-linkage-parent",
  "Validation precedes idempotency: an idempotent hit carrying a known parent creates NO edge and discards the proposal whole — on an in_progress holder — while the same key with an unknown parent fails E_UNKNOWN_ID outright.",
  [
    { op: "create", actor: A, at: T0, title: "container", type: "epic" },
    { op: "create", actor: A, at: T1, criterionId: "ac1", specItemRef: "spec:mini/it1", title: "first" },
    { op: "claim", actor: A, at: T2, id: "$2" },
    { op: "create", actor: A, at: T3, criterionId: "ac1", parent: "$1", specItemRef: "spec:mini/it1", title: "replay with parent" },
    { op: "create", actor: A, at: T4, criterionId: "ac1", parent: "legacy-ghost", specItemRef: "spec:mini/it1", title: "replay with unknown parent" },
    { op: "show", id: "$2" },
    { op: "export" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    actOK,
    createOK("$2", false),
    createErr(["E_UNKNOWN_ID"]),
    showOK(
      task({
        assignee: A, createdAt: T1, criterionId: "ac1", id: "$2",
        specItemRef: "spec:mini/it1", startedAt: T2, status: "in_progress", title: "first",
      }),
    ),
    exportOK(
      [
        exTask({ id: "$1", title: "container", type: "epic" }),
        exTask({
          assignee: A, createdAt: T1, criterionId: "ac1", id: "$2",
          specItemRef: "spec:mini/it1", startedAt: T2, status: "in_progress", title: "first",
        }),
      ],
      [],
    ),
  ],
);

fx(
  "fx-linkage-idempotent",
  "Re-creating a held (specItemRef, criterionId) key returns the existing id with created false — before and after the holder closes — the holder's fields survive the colliding proposals, report lists one entry, and the create after the hits takes token $2, not $4.",
  [
    { op: "create", actor: A, at: T0, criterionId: "ac1", specItemRef: "spec:mini/it1", title: "implement ac1" },
    { op: "create", actor: A, at: T1, criterionId: "ac1", priority: 0, specItemRef: "spec:mini/it1", title: "audit re-proposes" },
    { op: "close", actor: A, at: T2, id: "$1" },
    { op: "create", actor: A, at: T3, criterionId: "ac1", specItemRef: "spec:mini/it1", title: "audit re-proposes again" },
    { op: "show", id: "$1" },
    { op: "report" },
    { op: "create", actor: A, at: T4, title: "fresh after the hits" },
  ],
  [
    createOK("$1"),
    createOK("$1", false),
    actOK,
    createOK("$1", false),
    showOK(
      task({
        closedAt: T2, criterionId: "ac1", id: "$1", specItemRef: "spec:mini/it1",
        status: "closed", title: "implement ac1",
      }),
    ),
    entriesOK([{ criterionId: "ac1", specItemRef: "spec:mini/it1", status: "done", taskRef: "$1" }]),
    createOK("$2"),
  ],
);

fx(
  "fx-linkage-distinct",
  "Distinct criterionIds and the keyless form under one specItemRef are three distinct tasks; report sorts the keyless entry first.",
  [
    { op: "create", actor: A, at: T0, criterionId: "ac1", specItemRef: "spec:mini/it1", title: "a" },
    { op: "create", actor: A, at: T1, criterionId: "ac2", specItemRef: "spec:mini/it1", title: "b" },
    { op: "create", actor: A, at: T2, specItemRef: "spec:mini/it1", title: "item-level" },
    { op: "report" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    createOK("$3"),
    entriesOK([
      { specItemRef: "spec:mini/it1", status: "open", taskRef: "$3" },
      { criterionId: "ac1", specItemRef: "spec:mini/it1", status: "open", taskRef: "$1" },
      { criterionId: "ac2", specItemRef: "spec:mini/it1", status: "open", taskRef: "$2" },
    ]),
  ],
);

// -- lifecycle

fx(
  "fx-claim",
  "claim moves open to in_progress and stamps assignee and startedAt from the command.",
  [
    { op: "create", actor: A, at: T0, title: "work" },
    { op: "claim", actor: A, at: T1, id: "$1" },
    { op: "show", id: "$1" },
  ],
  [
    createOK("$1"),
    actOK,
    showOK(task({ assignee: A, id: "$1", startedAt: T1, status: "in_progress", title: "work" })),
  ],
);

fx(
  "fx-claim-bad",
  "Re-claiming an in_progress task and reopening it are E_BAD_TRANSITION; an unknown literal id with a bad timestamp co-fires E_BAD_TIMESTAMP and E_UNKNOWN_ID without E_BAD_TRANSITION; an unresolved $-token is an unknown referent; failed commands change nothing.",
  [
    { op: "create", actor: A, at: T0, title: "work" },
    { op: "claim", actor: A, at: T1, id: "$1" },
    { op: "claim", actor: A, at: T2, id: "$1" },
    { op: "reopen", actor: A, at: T2, id: "$1" },
    { op: "claim", actor: A, at: "2026-06-12T18:00:00", id: "legacy-ghost" },
    { op: "claim", actor: A, at: T3, id: "$9" },
    { op: "show", id: "$1" },
  ],
  [
    createOK("$1"),
    actOK,
    actErr(["E_BAD_TRANSITION"]),
    actErr(["E_BAD_TRANSITION"]),
    actErr(["E_BAD_TIMESTAMP", "E_UNKNOWN_ID"]),
    actErr(["E_UNKNOWN_ID"]),
    showOK(task({ assignee: A, id: "$1", startedAt: T1, status: "in_progress", title: "work" })),
  ],
);

fx(
  "fx-close",
  "close stamps closedAt and an optional closeReason; claim stamps survive a close; a never-claimed task closes straight from open without a closeReason key.",
  [
    { op: "create", actor: A, at: T0, title: "ship it" },
    { op: "claim", actor: A, at: T1, id: "$1" },
    { op: "close", actor: A, at: T2, id: "$1", reason: "shipped" },
    { op: "show", id: "$1" },
    { op: "create", actor: A, at: T3, title: "quick note" },
    { op: "close", actor: A, at: T4, id: "$2" },
    { op: "show", id: "$2" },
  ],
  [
    createOK("$1"),
    actOK,
    actOK,
    showOK(task({ assignee: A, closeReason: "shipped", closedAt: T2, id: "$1", startedAt: T1, status: "closed", title: "ship it" })),
    createOK("$2"),
    actOK,
    showOK(task({ closedAt: T4, createdAt: T3, id: "$2", status: "closed", title: "quick note" })),
  ],
);

fx(
  "fx-close-closed",
  "Closing or claiming a closed task is E_BAD_TRANSITION; on a known target it CO-FIRES with a non-string reason and an offsetless at in one sorted set; the original close stamps hold throughout.",
  [
    { op: "create", actor: A, at: T0, title: "once" },
    { op: "close", actor: A, at: T1, id: "$1", reason: "done" },
    { op: "close", actor: A, at: T2, id: "$1", reason: "again" },
    { op: "close", actor: A, at: "2026-06-12T18:00:00", id: "$1", reason: 42 },
    { op: "claim", actor: A, at: T3, id: "$1" },
    { op: "close", actor: A, at: T4, id: "legacy-ghost" },
    { op: "show", id: "$1" },
  ],
  [
    createOK("$1"),
    actOK,
    actErr(["E_BAD_TRANSITION"]),
    actErr(["E_BAD_FIELD", "E_BAD_TIMESTAMP", "E_BAD_TRANSITION"]),
    actErr(["E_BAD_TRANSITION"]),
    actErr(["E_UNKNOWN_ID"]),
    showOK(task({ closeReason: "done", closedAt: T1, id: "$1", status: "closed", title: "once" })),
  ],
);

fx(
  "fx-reopen",
  "reopen returns a claimed-then-closed task to open with every claim and close stamp removed; reopening an open task is E_BAD_TRANSITION.",
  [
    { op: "create", actor: A, at: T0, title: "back again" },
    { op: "claim", actor: A, at: T1, id: "$1" },
    { op: "close", actor: A, at: T2, id: "$1", reason: "oops" },
    { op: "reopen", actor: A, at: T3, id: "$1" },
    { op: "show", id: "$1" },
    { op: "reopen", actor: A, at: T4, id: "$1" },
    { op: "reopen", actor: A, at: T4, id: "legacy-ghost" },
  ],
  [
    createOK("$1"),
    actOK,
    actOK,
    actOK,
    showOK(task({ id: "$1", title: "back again" })),
    actErr(["E_BAD_TRANSITION"]),
    actErr(["E_UNKNOWN_ID"]),
  ],
);

// -- ready

fx(
  "fx-ready-sort",
  "ready sorts by priority ascending, ties by creation order ascending — the equal-priority pair carries timestamps in REVERSE creation order, so a createdAt-sorted queue diverges.",
  [
    { op: "create", actor: A, at: T3, title: "last by priority" },
    { op: "create", actor: A, at: T2, priority: 1, title: "first of the ones" },
    { op: "create", actor: A, at: T0, priority: 1, title: "second of the ones" },
    { op: "create", actor: A, at: T1, priority: 0, title: "the zero" },
    { op: "ready" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    createOK("$3"),
    createOK("$4"),
    entriesOK([
      { id: "$4", priority: 0, title: "the zero", type: "task" },
      { id: "$2", priority: 1, title: "first of the ones", type: "task" },
      { id: "$3", priority: 1, title: "second of the ones", type: "task" },
      { id: "$1", priority: 2, title: "last by priority", type: "task" },
    ]),
  ],
);

fx(
  "fx-ready-epic",
  "Epics never appear in ready — even at priority 0, where wrong inclusion would head the queue; their children do.",
  [
    { op: "create", actor: A, at: T0, priority: 0, title: "container", type: "epic" },
    { op: "create", actor: A, at: T1, parent: "$1", title: "child" },
    { op: "ready" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    entriesOK([{ id: "$2", priority: 2, title: "child", type: "task" }]),
  ],
);

fx(
  "fx-ready-status",
  "in_progress and closed tasks never appear in ready.",
  [
    { op: "create", actor: A, at: T0, title: "open one" },
    { op: "create", actor: A, at: T1, title: "taken" },
    { op: "create", actor: A, at: T2, title: "done one" },
    { op: "claim", actor: A, at: T3, id: "$2" },
    { op: "close", actor: A, at: T4, id: "$3" },
    { op: "ready" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    createOK("$3"),
    actOK,
    actOK,
    entriesOK([{ id: "$1", priority: 2, title: "open one", type: "task" }]),
  ],
);

fx(
  "fx-ready-block",
  "An open blocks-blocker excludes the dependent from ready; a merely claimed blocker still excludes it.",
  [
    { op: "create", actor: A, at: T0, priority: 0, title: "downstream" },
    { op: "create", actor: A, at: T1, title: "upstream" },
    { op: "link", actor: A, at: T2, dependsOn: "$2", id: "$1", type: "blocks" },
    { op: "ready" },
    { op: "claim", actor: A, at: T3, id: "$2" },
    { op: "ready" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    actOK,
    entriesOK([{ id: "$2", priority: 2, title: "upstream", type: "task" }]),
    actOK,
    entriesOK([]),
  ],
);

fx(
  "fx-ready-unblock",
  "Closing the blocker releases the dependent into ready.",
  [
    { op: "create", actor: A, at: T0, title: "downstream" },
    { op: "create", actor: A, at: T1, title: "upstream" },
    { op: "link", actor: A, at: T2, dependsOn: "$2", id: "$1", type: "blocks" },
    { op: "close", actor: A, at: T3, id: "$2" },
    { op: "ready" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    actOK,
    actOK,
    entriesOK([{ id: "$1", priority: 2, title: "downstream", type: "task" }]),
  ],
);

fx(
  "fx-ready-parent",
  "parent-child edges never gate readiness: a non-epic parent and its child are both ready.",
  [
    { op: "create", actor: A, at: T0, title: "parent task" },
    { op: "create", actor: A, at: T1, parent: "$1", title: "child task" },
    { op: "ready" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    entriesOK([
      { id: "$1", priority: 2, title: "parent task", type: "task" },
      { id: "$2", priority: 2, title: "child task", type: "task" },
    ]),
  ],
);

// -- links

fx(
  "fx-link",
  "Two blocks edges added in an order that disagrees with id order render in EDGE-CREATION order in show.dependsOn and export.links — an id-sorted rendering diverges.",
  [
    { op: "create", actor: A, at: T0, title: "a" },
    { op: "create", actor: A, at: T1, title: "b" },
    { op: "create", actor: A, at: T2, title: "c" },
    { op: "link", actor: A, at: T3, dependsOn: "$3", id: "$1", type: "blocks" },
    { op: "link", actor: A, at: T4, dependsOn: "$2", id: "$1", type: "blocks" },
    { op: "show", id: "$1" },
    { op: "export" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    createOK("$3"),
    actOK,
    actOK,
    showOK(task({ dependsOn: ["$3", "$2"], id: "$1", title: "a" })),
    exportOK(
      [
        exTask({ id: "$1", title: "a" }),
        exTask({ createdAt: T1, id: "$2", title: "b" }),
        exTask({ createdAt: T2, id: "$3", title: "c" }),
      ],
      [
        { dependsOn: "$3", id: "$1", type: "blocks" },
        { dependsOn: "$2", id: "$1", type: "blocks" },
      ],
    ),
  ],
);

fx(
  "fx-link-cycle",
  "Cycles are refused per type-graph: a blocks chain refuses its closing edge and the self-link; the parent graph accepts the reverse of a blocks edge but refuses its own 2-cycle.",
  [
    { op: "create", actor: A, at: T0, title: "a" },
    { op: "create", actor: A, at: T1, title: "b" },
    { op: "create", actor: A, at: T2, title: "c" },
    { op: "link", actor: A, at: T3, dependsOn: "$2", id: "$1", type: "blocks" },
    { op: "link", actor: A, at: T3, dependsOn: "$3", id: "$2", type: "blocks" },
    { op: "link", actor: A, at: T4, dependsOn: "$1", id: "$3", type: "blocks" },
    { op: "link", actor: A, at: T4, dependsOn: "$1", id: "$1", type: "blocks" },
    { op: "link", actor: A, at: T5, dependsOn: "$1", id: "$2", type: "parent-child" },
    { op: "link", actor: A, at: T5, dependsOn: "$2", id: "$1", type: "parent-child" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    createOK("$3"),
    actOK,
    actOK,
    actErr(["E_CYCLE"]),
    actErr(["E_CYCLE"]),
    actOK,
    actErr(["E_CYCLE"]),
  ],
);

fx(
  "fx-link-parent",
  "A second parent-child edge to a DIFFERENT parent is E_HAS_PARENT; the original parent holds.",
  [
    { op: "create", actor: A, at: T0, title: "child" },
    { op: "create", actor: A, at: T1, title: "first parent" },
    { op: "create", actor: A, at: T2, title: "rival parent" },
    { op: "link", actor: A, at: T3, dependsOn: "$2", id: "$1", type: "parent-child" },
    { op: "link", actor: A, at: T4, dependsOn: "$3", id: "$1", type: "parent-child" },
    { op: "show", id: "$1" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    createOK("$3"),
    actOK,
    actErr(["E_HAS_PARENT"]),
    showOK(task({ id: "$1", parent: "$2", title: "child" })),
  ],
);

fx(
  "fx-link-dup",
  "Re-linking an identical edge — blocks or parent-child — is an accepted no-op: one edge each in export, and the repeated parent edge is never E_HAS_PARENT.",
  [
    { op: "create", actor: A, at: T0, title: "a" },
    { op: "create", actor: A, at: T1, title: "b" },
    { op: "link", actor: A, at: T2, dependsOn: "$2", id: "$1", type: "blocks" },
    { op: "link", actor: A, at: T3, dependsOn: "$2", id: "$1", type: "blocks" },
    { op: "link", actor: A, at: T4, dependsOn: "$2", id: "$1", type: "parent-child" },
    { op: "link", actor: A, at: T5, dependsOn: "$2", id: "$1", type: "parent-child" },
    { op: "show", id: "$1" },
    { op: "export" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    actOK,
    actOK,
    actOK,
    actOK,
    showOK(task({ dependsOn: ["$2"], id: "$1", parent: "$2", title: "a" })),
    exportOK(
      [exTask({ id: "$1", title: "a" }), exTask({ createdAt: T1, id: "$2", title: "b" })],
      [
        { dependsOn: "$2", id: "$1", type: "blocks" },
        { dependsOn: "$2", id: "$1", type: "parent-child" },
      ],
    ),
  ],
);

fx(
  "fx-link-invalid",
  "Unknown referents report E_UNKNOWN_ID once however many are unknown, co-fired with E_BAD_TYPE for an unknown type; a self-link with an offsetless at co-fires E_BAD_TIMESTAMP and E_CYCLE; no edge is recorded.",
  [
    { op: "create", actor: A, at: T0, title: "a" },
    { op: "link", actor: A, at: T1, dependsOn: "legacy-ghost", id: "$1", type: "strangles" },
    { op: "link", actor: A, at: T2, dependsOn: "legacy-also-gone", id: "legacy-gone", type: "blocks" },
    { op: "link", actor: A, at: "2026-06-12T18:00:00", dependsOn: "$1", id: "$1", type: "blocks" },
    { op: "export" },
  ],
  [
    createOK("$1"),
    actErr(["E_BAD_TYPE", "E_UNKNOWN_ID"]),
    actErr(["E_UNKNOWN_ID"]),
    actErr(["E_BAD_TIMESTAMP", "E_CYCLE"]),
    exportOK([exTask({ id: "$1", title: "a" })], []),
  ],
);

// -- annotate

fx(
  "fx-comment-order",
  "Comments render in submission order even when a later comment carries an earlier at — clock skew never rewrites history.",
  [
    { op: "create", actor: A, at: T0, title: "discussed" },
    { op: "comment", actor: A, at: "2026-06-12T19:00:00Z", id: "$1", text: "first said" },
    { op: "comment", actor: "jonathan", at: "2026-06-12T17:00:00Z", id: "$1", text: "second said, earlier clock" },
    { op: "show", id: "$1" },
  ],
  [
    createOK("$1"),
    actOK,
    actOK,
    showOK(
      task({
        comments: [
          { actor: A, at: "2026-06-12T19:00:00Z", text: "first said" },
          { actor: "jonathan", at: "2026-06-12T17:00:00Z", text: "second said, earlier clock" },
        ],
        id: "$1",
        title: "discussed",
      }),
    ),
  ],
);

fx(
  "fx-comment-invalid",
  "A comment naming an unknown id is E_UNKNOWN_ID; a comment missing text is E_MISSING_FIELD; an unparseable at is E_BAD_TIMESTAMP; none records anything.",
  [
    { op: "create", actor: A, at: T0, title: "quiet" },
    { op: "comment", actor: A, at: T1, id: "legacy-ghost", text: "into the void" },
    { op: "comment", actor: A, at: T2, id: "$1" },
    { op: "comment", actor: A, at: "not a clock", id: "$1", text: "skewed" },
    { op: "show", id: "$1" },
  ],
  [
    createOK("$1"),
    actErr(["E_UNKNOWN_ID"]),
    actErr(["E_MISSING_FIELD"]),
    actErr(["E_BAD_TIMESTAMP"]),
    showOK(task({ id: "$1", title: "quiet" })),
  ],
);

fx(
  "fx-update",
  "update replaces exactly the named fields, works on a closed task, and never touches status or stamps.",
  [
    { op: "create", actor: A, at: T0, title: "old title" },
    { op: "update", actor: A, at: T1, id: "$1", set: { assignee: A, description: "now described", priority: 0, title: "new title" } },
    { op: "close", actor: A, at: T2, id: "$1", reason: "shipped" },
    { op: "update", actor: A, at: T3, id: "$1", set: { description: "post-close amendment" } },
    { op: "show", id: "$1" },
  ],
  [
    createOK("$1"),
    actOK,
    actOK,
    actOK,
    showOK(
      task({
        assignee: A, closeReason: "shipped", closedAt: T2,
        description: "post-close amendment", id: "$1", priority: 0,
        status: "closed", title: "new title",
      }),
    ),
  ],
);

fx(
  "fx-update-invalid",
  "An empty, absent, or non-object set is E_MISSING_FIELD; a set naming status is E_BAD_FIELD; an out-of-range priority and a non-string title co-fire sorted; the task is unchanged.",
  [
    { op: "create", actor: A, at: T0, title: "untouched" },
    { op: "update", actor: A, at: T1, id: "$1", set: {} },
    { op: "update", actor: A, at: T1, id: "$1" },
    { op: "update", actor: A, at: T1, id: "$1", set: "priority 0" },
    { op: "update", actor: A, at: T2, id: "$1", set: { status: "closed" } },
    { op: "update", actor: A, at: T3, id: "$1", set: { priority: 7, title: 9 } },
    { op: "update", actor: A, at: 42, id: "$1", set: { title: "never lands" } },
    { op: "update", actor: A, at: T4, id: "legacy-ghost", set: { title: "no target" } },
    { op: "show", id: "$1" },
  ],
  [
    createOK("$1"),
    actErr(["E_MISSING_FIELD"]),
    actErr(["E_MISSING_FIELD"]),
    actErr(["E_MISSING_FIELD"]),
    actErr(["E_BAD_FIELD"]),
    actErr(["E_BAD_FIELD", "E_BAD_PRIORITY"]),
    actErr(["E_MISSING_FIELD"]),
    actErr(["E_UNKNOWN_ID"]),
    showOK(task({ id: "$1", title: "untouched" })),
  ],
);

// -- query

fx(
  "fx-show",
  "show renders exactly the held keys — every optional present when held, absent otherwise — and an unknown id is E_UNKNOWN_ID with task null.",
  [
    { op: "show", id: "legacy-ghost" },
    { op: "create", actor: A, at: T0, criterionId: "ac9", description: "all fields", legacyRef: "art-419", priority: 1, specItemRef: "spec:mini/it9", title: "everything", type: "feature" },
    { op: "show", id: "$1" },
  ],
  [
    showErr,
    createOK("$1"),
    showOK(
      task({
        criterionId: "ac9", description: "all fields", id: "$1",
        legacyRef: "art-419", priority: 1, specItemRef: "spec:mini/it9",
        title: "everything", type: "feature",
      }),
    ),
  ],
);

fx(
  "fx-list",
  "Unfiltered list shows every task in creation order — the timestamps run in reverse, so a createdAt-sorted list diverges — whatever the status; the open filter restricts; a filter outside the vocabulary is E_BAD_FIELD.",
  [
    { op: "create", actor: A, at: T2, title: "one" },
    { op: "create", actor: A, at: T1, title: "two" },
    { op: "create", actor: A, at: T0, title: "three" },
    { op: "claim", actor: A, at: T3, id: "$2" },
    { op: "close", actor: A, at: T4, id: "$3" },
    { op: "list" },
    { op: "list", status: "open" },
    { op: "list", status: "in_progress" },
    { op: "list", status: "closed" },
    { op: "list", status: "done" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    createOK("$3"),
    actOK,
    actOK,
    entriesOK([
      { id: "$1", priority: 2, status: "open", title: "one", type: "task" },
      { id: "$2", priority: 2, status: "in_progress", title: "two", type: "task" },
      { id: "$3", priority: 2, status: "closed", title: "three", type: "task" },
    ]),
    entriesOK([{ id: "$1", priority: 2, status: "open", title: "one", type: "task" }]),
    entriesOK([{ id: "$2", priority: 2, status: "in_progress", title: "two", type: "task" }]),
    entriesOK([{ id: "$3", priority: 2, status: "closed", title: "three", type: "task" }]),
    entriesErr(["E_BAD_FIELD"]),
  ],
);

fx(
  "fx-report",
  "report lists only spec-linked tasks, sorted by (specItemRef, criterionId, taskRef) with the keyless entry first, statuses projected.",
  [
    { op: "create", actor: A, at: T0, title: "adhoc" },
    { op: "create", actor: A, at: T1, criterionId: "ac9", specItemRef: "spec:mini/it2", title: "b" },
    { op: "create", actor: A, at: T2, criterionId: "ac1", specItemRef: "spec:mini/it1", title: "c" },
    { op: "create", actor: A, at: T3, specItemRef: "spec:mini/it1", title: "d" },
    { op: "claim", actor: A, at: T4, id: "$2" },
    { op: "report" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    createOK("$3"),
    createOK("$4"),
    actOK,
    entriesOK([
      { specItemRef: "spec:mini/it1", status: "open", taskRef: "$4" },
      { criterionId: "ac1", specItemRef: "spec:mini/it1", status: "open", taskRef: "$3" },
      { criterionId: "ac9", specItemRef: "spec:mini/it2", status: "in_progress", taskRef: "$2" },
    ]),
  ],
);

fx(
  "fx-report-cancelled",
  "Only closeReason exactly \"cancelled\" projects to cancelled — \"shipped\" and \"Cancelled\" project to done; the match is full-string and case-sensitive.",
  [
    { op: "create", actor: A, at: T0, criterionId: "ac1", specItemRef: "spec:mini/it1", title: "a" },
    { op: "create", actor: A, at: T1, criterionId: "ac2", specItemRef: "spec:mini/it1", title: "b" },
    { op: "create", actor: A, at: T2, criterionId: "ac3", specItemRef: "spec:mini/it1", title: "c" },
    { op: "close", actor: A, at: T3, id: "$1", reason: "cancelled" },
    { op: "close", actor: A, at: T4, id: "$2", reason: "shipped" },
    { op: "close", actor: A, at: T5, id: "$3", reason: "Cancelled" },
    { op: "report" },
  ],
  [
    createOK("$1"),
    createOK("$2"),
    createOK("$3"),
    actOK,
    actOK,
    actOK,
    entriesOK([
      { criterionId: "ac1", specItemRef: "spec:mini/it1", status: "cancelled", taskRef: "$1" },
      { criterionId: "ac2", specItemRef: "spec:mini/it1", status: "done", taskRef: "$2" },
      { criterionId: "ac3", specItemRef: "spec:mini/it1", status: "done", taskRef: "$3" },
    ]),
  ],
);

// -- portability

fx(
  "fx-export",
  "Export carries every held field of every task verbatim — linkage, legacyRef, claim stamps, comments — in creation order (the second-created task carries the EARLIER createdAt), with edges in links.",
  [
    { op: "create", actor: A, at: T0, criterionId: "ac1", description: "carries everything", legacyRef: "art-999", priority: 1, specItemRef: "spec:mini/it1", title: "rich", type: "bug" },
    { op: "claim", actor: A, at: T1, id: "$1" },
    { op: "comment", actor: A, at: T2, id: "$1", text: "working on it" },
    { op: "create", actor: A, at: "2026-06-12T17:00:00Z", title: "plain friend" },
    { op: "link", actor: A, at: T4, dependsOn: "$1", id: "$2", type: "blocks" },
    { op: "export" },
  ],
  [
    createOK("$1"),
    actOK,
    actOK,
    createOK("$2"),
    actOK,
    exportOK(
      [
        exTask({
          assignee: A,
          comments: [{ actor: A, at: T2, text: "working on it" }],
          criterionId: "ac1", description: "carries everything", id: "$1",
          legacyRef: "art-999", priority: 1, specItemRef: "spec:mini/it1",
          startedAt: T1, status: "in_progress", title: "rich", type: "bug",
        }),
        exTask({ createdAt: "2026-06-12T17:00:00Z", id: "$2", title: "plain friend" }),
      ],
      [{ dependsOn: "$1", id: "$2", type: "blocks" }],
    ),
  ],
);

fx(
  "fx-import",
  "Import holds export-shaped records verbatim under their literal ids — stamps, comments, legacyRef, and the parent edge intact — and later creates extend creation order.",
  [
    {
      op: "import", actor: A, at: T0,
      tasks: [
        { comments: [], createdAt: "2026-01-05T00:00:00Z", createdBy: A, id: "legacy-1", legacyRef: "art-ubo", priority: 1, status: "open", title: "old epic", type: "epic" },
        { closeReason: "shipped", closedAt: "2026-02-01T00:00:00Z", comments: [{ actor: A, at: "2026-01-07T00:00:00Z", text: "carried across" }], createdAt: "2026-01-06T00:00:00Z", createdBy: A, id: "legacy-2", priority: 2, status: "closed", title: "old child", type: "task" },
      ],
      links: [{ dependsOn: "legacy-1", id: "legacy-2", type: "parent-child" }],
    },
    { op: "show", id: "legacy-2" },
    { op: "create", actor: A, at: T1, title: "new work" },
    { op: "list" },
  ],
  [
    importOK(2),
    showOK({
      closeReason: "shipped", closedAt: "2026-02-01T00:00:00Z",
      comments: [{ actor: A, at: "2026-01-07T00:00:00Z", text: "carried across" }],
      createdAt: "2026-01-06T00:00:00Z", createdBy: A, dependsOn: [],
      id: "legacy-2", parent: "legacy-1", priority: 2, status: "closed",
      title: "old child", type: "task",
    }),
    createOK("$1"),
    entriesOK([
      { id: "legacy-1", priority: 1, status: "open", title: "old epic", type: "epic" },
      { id: "legacy-2", parent: "legacy-1", priority: 2, status: "closed", title: "old child", type: "task" },
      { id: "$1", priority: 2, status: "open", title: "new work", type: "task" },
    ]),
  ],
);

fx(
  "fx-import-dup",
  "An import colliding with a held linkage key and repeating an id within its own payload reports both codes sorted, imports nothing, and leaves the store as it was.",
  [
    { op: "create", actor: A, at: T0, criterionId: "ac1", specItemRef: "spec:mini/it1", title: "already here" },
    {
      op: "import", actor: A, at: T1,
      tasks: [
        { comments: [], createdAt: "2026-01-01T00:00:00Z", createdBy: A, criterionId: "ac1", id: "legacy-1", priority: 2, specItemRef: "spec:mini/it1", status: "open", title: "collides by linkage", type: "task" },
        { comments: [], createdAt: "2026-01-02T00:00:00Z", createdBy: A, id: "legacy-1", priority: 2, status: "open", title: "collides by id", type: "task" },
      ],
    },
    { op: "list" },
  ],
  [
    createOK("$1"),
    importErr(["E_DUP_ID", "E_DUP_LINKAGE"]),
    entriesOK([{ id: "$1", priority: 2, status: "open", title: "already here", type: "task" }]),
  ],
);

fx(
  "fx-import-invalid",
  "One import payload violating many rules at once — id collision with a HELD imported id, within-payload linkage collision, bad type/status/priority vocabulary, an offsetless stamp, a malformed comment, forbidden parent/dependsOn keys, a missing title, a self-link, and a link from an unknown id — reports every code in one sorted set, imports nothing, and the store holds only what it held.",
  [
    {
      op: "import", actor: A, at: T0,
      tasks: [
        { createdAt: "2026-01-01T00:00:00Z", createdBy: A, id: "legacy-1", priority: 2, status: "open", title: "held import", type: "task" },
      ],
    },
    {
      op: "import", actor: A, at: T1,
      tasks: [
        { createdAt: "2026-01-02T00:00:00Z", createdBy: A, id: "legacy-1", priority: 2, status: "open", title: "collides with held", type: "task" },
        { createdAt: "2026-01-03T00:00:00", createdBy: A, id: "legacy-2", priority: 9, status: "paused", title: "bad vocabulary", type: "saga" },
        { createdAt: "2026-01-04T00:00:00Z", createdBy: A, dependsOn: ["legacy-1"], id: "legacy-3", parent: "legacy-1", priority: 2, status: "open", title: "forbidden edge keys", type: "task" },
        { createdAt: "2026-01-05T00:00:00Z", createdBy: A, id: "legacy-4", priority: 2, status: "open", type: "task" },
        { comments: [{ actor: A, at: "2026-01-06T00:00:00", text: "offsetless comment" }], createdAt: "2026-01-06T00:00:00Z", createdBy: A, criterionId: "ac1", id: "legacy-5", priority: 2, specItemRef: "spec:mini/itX", status: "open", title: "first of colliding pair", type: "task" },
        { createdAt: "2026-01-07T00:00:00Z", createdBy: A, criterionId: "ac1", id: "legacy-6", priority: 2, specItemRef: "spec:mini/itX", status: "open", title: "second of colliding pair", type: "task" },
      ],
      links: [
        { dependsOn: "legacy-1", id: "legacy-9", type: "blocks" },
        { dependsOn: "legacy-1", id: "legacy-1", type: "blocks" },
      ],
    },
    { op: "list" },
  ],
  [
    importOK(1),
    importErr([
      "E_BAD_FIELD", "E_BAD_PRIORITY", "E_BAD_TIMESTAMP", "E_BAD_TYPE",
      "E_CYCLE", "E_DUP_ID", "E_DUP_LINKAGE", "E_MISSING_FIELD", "E_UNKNOWN_ID",
    ]),
    entriesOK([{ id: "legacy-1", priority: 2, status: "open", title: "held import", type: "task" }]),
  ],
);

fx(
  "fx-roundtrip",
  "Importing an export-shaped payload into an empty store and exporting yields the payload exactly — the exit door is lossless in both directions.",
  [
    {
      op: "import", actor: A, at: T0,
      tasks: [
        { comments: [], createdAt: "2026-01-05T00:00:00Z", createdBy: A, description: "kept whole", id: "legacy-a", legacyRef: "art-111", priority: 1, status: "open", title: "survivor", type: "feature" },
        { closeReason: "cancelled", closedAt: "2026-03-01T00:00:00Z", comments: [{ actor: "jonathan", at: "2026-02-01T00:00:00Z", text: "calling it" }], createdAt: "2026-01-06T00:00:00Z", createdBy: A, id: "legacy-b", priority: 3, status: "closed", title: "abandoned", type: "task" },
      ],
      links: [{ dependsOn: "legacy-a", id: "legacy-b", type: "blocks" }],
    },
    { op: "export" },
  ],
  [
    importOK(2),
    exportOK(
      [
        { comments: [], createdAt: "2026-01-05T00:00:00Z", createdBy: A, description: "kept whole", id: "legacy-a", legacyRef: "art-111", priority: 1, status: "open", title: "survivor", type: "feature" },
        { closeReason: "cancelled", closedAt: "2026-03-01T00:00:00Z", comments: [{ actor: "jonathan", at: "2026-02-01T00:00:00Z", text: "calling it" }], createdAt: "2026-01-06T00:00:00Z", createdBy: A, id: "legacy-b", priority: 3, status: "closed", title: "abandoned", type: "task" },
      ],
      [{ dependsOn: "legacy-a", id: "legacy-b", type: "blocks" }],
    ),
  ],
);

// ------------------------------------------------------------- emit + gate

// CS7 order: preamble, each item followed by its criteria in declared order.
const specRecords = [preamble];
for (const it of items) {
  specRecords.push(it);
  for (const c of criteria) if (c.itemId === it.id) specRecords.push(c);
}
const fixtureRecords = sortFixtures(fixtures);

const all = [...specRecords, ...fixtureRecords];
const verdict = validateAuthorOutput({ spec: all, new: criteria.map((c) => c.id) });
if (!verdict.valid) {
  console.error("validateAuthorOutput REFUSED:");
  for (const e of verdict.errors) console.error(`  ${e.code} ${e.ref}`);
  process.exit(1);
}

writeFileSync(join(outDir, "spec.jsonl"), serialize(specRecords));
writeFileSync(join(outDir, "fixtures.jsonl"), serialize(fixtureRecords));
console.log(
  `OK: ${items.length} items, ${criteria.length} criteria, ${fixtureRecords.length} fixtures — author-output valid.`,
);
