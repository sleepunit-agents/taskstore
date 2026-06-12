# taskstore-core 0.1.0 — authoring interview record

*Greenfield interview per felag-core `it-author-interview`. The interview is
conduct, not artifact — this record exists for the cold reviewer and the merge
gate, not for any felag verb. Mode (per the ceremony runbook): Art answers as
product owner — this is Art's own work store, replacing beads per Jonathan's
2026-06-12 directive ("the beads integration is temporary; the goal is our own
task implementation"). Jonathan reviews at the merge gate.*

## Stakeholder input

Six months of agent-driven work tracking ran on beads (bd) at ~/Art. The trial
proved the *shape* (durable issues, ready queue, dependencies, epics, a
JSONL exit door) and surfaced the residue: a junk-drawer feature surface
(gates, swarms, formulas, federation, memories) that fought the loom boundary,
and an exit door that turned out to be decorative — see the evidence. Wanted:
a MUST-minimal first-party store carrying exactly the working surface Art
actually uses, conforming to felag-tasks so `felag audit` drives it directly.

## Evidence gathered before any decision

1. **Observed bd verb surface** (routines/*.md, CLAUDE.md, .beads/interactions.jsonl,
   live ceremony usage): `create` (title/description/type/priority/parent),
   `ready`, `show`, `list` (--all, --status), `update --claim`, `close
   --reason`, `comment`, `dep add` (blocks, parent-child), `bd export`.
   Never used: defer, labels, gates, swarm, formulas, supersede, federation,
   wisps, todo, kv, search-as-workflow. `bd remember` is *prohibited* here
   (loom boundary, CLAUDE.md override).
2. **Observed data surface** (.beads/issues.jsonl + bd show): types task/epic/bug;
   priorities 1–3 of the 0–4 range; statuses open/in_progress/closed;
   close_reason, started_at, closed_at, assignee, comments (actor, time, text),
   dependencies typed blocks | parent-child. Dotted child ids (art-ubo.6) and
   random-suffix ids (art-419) both in use; ids are opaque in practice.
3. **The passive export is stale and lossy** (probed 2026-06-12): 24 of 45
   issues present, no description/notes fields, last touched a day behind the
   live DB. The "exit door" beads taught us to demand turns out to be one bd
   never reliably held open. This is the single sharpest brownfield finding:
   the export contract must be *fixture-carried, lossless, and live*, not a
   side-effect convention.
4. **Sandbox probe of `bd ready`** (2026-06-12): epics APPEAR in the ready
   queue (a P1 epic sat in the middle of the probe queue, as art-ubo does in
   the real one); blocks-deps gate readiness and close-of-blocker releases;
   parent-child does not block; sort is priority then id-ish. Epic noise is
   live friction in ~/Art today.
5. **The felag-tasks beads shim** (felag-ts test/tasks-shim-beads.test.ts)
   proved a foreign tracker conforms via mapping only; its documented lossy
   edge — beads has no `cancelled`, so contract `cancelled` reports back
   `done` — is exactly the kind of edge a greenfield store can close.

## Decisions

Each answers the front-loaded questions: *contract or choice? could a
stranger get it wrong? which fixture proves it?*

### D1. The unit under contract is a pure transition function

`apply: (state, command) → (result, state)` — every command carries its clock
(`at`, an RFC 3339 instant per felag-core 2.0.0) and its `actor`; the store
never reads a wall clock. Fixtures are op-sequences: state threads through,
results are compared. **Contract** (the function); storage engine, CLI shape,
file locations, the daemonless single-process model — excluded.
*Stranger error:* stamping `created_at` from the host clock, making every
fixture nondeterministic. *Proof:* every fixture, structurally — expected
results contain timestamps only ever copied from command inputs.

### D2. State is observed through query commands, never dumped

Results are the only observable; `show`, `list`, `ready`, `report`, `export`
are the windows. The op-sequence wire format compares results exactly
(felag-tasks precedent), with **generated ids normalized to $-tokens by order
of first appearance**; caller-supplied ids (import) stay literal.
*Stranger error:* comparing internal state shapes, pinning an implementation's
schema. *Proof:* the wire-format definition + every fixture.

### D3. Command vocabulary = the observed surface, nothing else

`create, claim, close, reopen, update, comment, link, show, list, ready,
report, export, import`. Thirteen ops; each one traces to a verb in evidence
item 1 or to the exit door (export/import) or the felag-tasks projection
(report). Defer, labels, search, stats: **excluded, deferred-not-refused** —
they arrive as `proposed` criteria via promotion if wanted.
*Stranger error:* mirroring bd's whole junk drawer (the excavate X1 failure
mode). *Proof:* the preamble exclusions, loudly.

### D4. Status vocabulary: open | in_progress | closed; blocked is derived

Exactly the three statuses evidence shows in use. `blocked` is a *view*
(open task with an unclosed blocker), never stored — bd agrees. `deferred`
excluded at 0.1.0. Transitions: create→open; claim: open→in_progress
(stamps assignee=actor, startedAt=at); close: open|in_progress→closed
(stamps closedAt=at, closeReason); reopen: closed→open (clears the close
stamps; history lives in comments). Anything else: E_BAD_TRANSITION.
*Stranger error:* claim on a closed task silently succeeding; reopen
preserving a stale closedAt. *Proof:* fx-claim, fx-close, fx-reopen, and the
bad-transition fixtures.

### D5. Ready queue: open, non-container, unblocked — epics excluded

ready = status open AND type ≠ epic AND every blocks-blocker closed. Sorted
by (priority ascending, creation order ascending). **Deliberate divergence
from bd** (evidence item 4): an epic is a container, not workable; epics in
the queue are noise Art scrolls past today. Parent-child links never gate
readiness — children of open epics are workable (art-ubo.6 itself was).
*Stranger error:* copying bd and including epics; treating parent-child as
blocking; sorting by id (nondeterministic across implementations).
*Proof:* fx-ready-sort, fx-ready-epic-excluded, fx-ready-blocked,
fx-ready-unblock, fx-ready-parent-child.

### D6. IDs are opaque; the prefix shape is judgment

Generated ids are opaque strings, unique within the store, never reused.
The product constraint — stable short prefix form (art-xxx style) — is a
**judgment criterion**: the generation scheme (random suffix, dotted children,
sequence) is implementation surface; pinning it would forbid better schemes
for no behavioral gain. Fixture exchange sees only $-tokens.
*Stranger error:* fixturing literal generated ids, making the corpus pass
exactly one implementation. *Proof:* the normalization rule; the judgment
criterion carries the shape.

### D7. Validation is loud, all-applicable, and sorted

Mutating commands validate and report **every** holding error, sorted
ascending — the felag promotion-protocol stance, never short-circuiting.
Codes at 0.1.0: E_MISSING_FIELD, E_BAD_TYPE, E_BAD_PRIORITY, E_BAD_TIMESTAMP,
E_UNKNOWN_ID, E_BAD_TRANSITION, E_CYCLE, E_HAS_PARENT, E_DUP_ID. Priorities
are integers 0–4 (default 2); invalid values **error** rather than coerce —
unlike watchdog's config totality, commands are agent-issued and a loud error
self-corrects where a silent default drifts. Types: task | bug | feature |
epic (default task); only epic carries contract semantics (D5).
*Stranger error:* first-error-only reporting (divergent error lists across
implementations); coercing "high" to a number. *Proof:* fx-create-invalid
(missing title + bad type + bad priority in one command, all three codes,
sorted).

### D8. Spec linkage is native; create is idempotent on it

create accepts optional `specItemRef` + `criterionId`; a create naming a
(specItemRef, criterionId) pair already held returns the existing id with
`created: false` — the c-tasks idempotency rule, native. The `report` op is
the c-tasks projection: spec-linked tasks as {taskRef, specItemRef,
criterionId?, status} sorted by (specItemRef, criterionId, taskRef), statuses
mapped open→open, in_progress→in_progress, closed→done — **except closed
with closeReason "cancelled" → cancelled**, closing the lossy edge the beads
shim documented (evidence item 5). The felag-tasks WorkLayer over this store
is then mapping only (ac-task-shim-thin), and conformance to felag-tasks is
proven by running the c-tasks fixture corpus over it.
*Stranger error:* idempotency keyed on specItemRef alone (distinct criteria
collapse); mapping every closed task to done (cancelled lies as done).
*Proof:* fx-linkage-idempotent, fx-linkage-distinct, fx-report (cancelled
mapping pinned).

### D9. Export is lossless and live; import preserves identity

export returns every task with every contract field — description, comments,
links, linkage, stamps, legacyRef — plus links, in creation order. This is
the exit door as a fixture-carried MUST, the direct answer to evidence
item 3. import accepts exported-shape records (caller-supplied ids stay
literal, collisions E_DUP_ID, `legacyRef` preserved for migrated history).
Round-trip: export → empty store → import → export is identity.
*Stranger error:* export-as-summary (beads' actual behavior: stale, lossy);
import regenerating ids and severing links.
*Proof:* fx-export-lossless, fx-import, fx-import-dup, fx-roundtrip.

### D10. Comments are append-only, in submission order

comment appends {actor, at, text}; show/export return them in submission
order, never re-sorted by `at` (clock skew must not reorder history).
*Stranger error:* sorting comments by timestamp. *Proof:* fx-comment-order
(second comment carries an earlier `at`; order holds).

### D11. The loom boundary is inviolate

The store holds work tracking only: no memory, knowledge, identity, or
prose-wiki surface — those live in loom. Written as a preamble exclusion AND
a judgment criterion, because the boundary that wasn't enforced is the
boundary beads ate. **Contract** (of the refusal kind).

### D12. Implementation language (choice, not contract)

TypeScript/Node, better-sqlite3 (WAL) for the binding's persistence, vitest,
felag-ts conformance.test.ts harness pattern — Jonathan's documented stack.
A conforming Python store is equally conforming; that is the point.

### D13. Concurrency, sync, multi-writer: excluded

One store, one writer at a time (WAL covers concurrent readers in the
binding). Dolt-style sync, federation: not this contract's business.

## Budgets

8 items planned, each ≤7 criteria (A2); all interview-authored criteria
source `forethought`, state `active` (merge ratifies — felag-core precedent).
