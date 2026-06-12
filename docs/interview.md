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

## Cold review round 1 — REWORK (2026-06-12)

All 36 fixtures traced clean ("no wrong expected value in any fixture");
every finding was the family's signature defect class — prose commitments
without discriminating fixtures. Eight MAJORs, all folded:

1. **Co-fire contradiction** between it-ts-model ("inputs field-valid") and
   it-ts-lifecycle (co-fires with field errors) — caught independently by
   the author mid-implementation, confirmed by the reviewer. Resolved:
   referent-interrogating checks are gated ONLY by what they interrogate;
   fx-close-closed now pins the triple co-fire
   {E_BAD_FIELD, E_BAD_TIMESTAMP, E_BAD_TRANSITION} on a known target.
2. Lone criterionId → E_MISSING_FIELD unfixtured — new fx-create-invalid.
3. Idempotent-hit field survival never observed — fx-linkage-idempotent now
   shows the holder after colliding proposals with different title/priority.
4. **Creation order never discriminated from timestamp order** anywhere
   monotonic clocks ran through the whole corpus. fx-ready-sort, fx-list,
   and fx-export now carry timestamps in reverse of creation order.
5. Import per-record validation entirely unfixtured (the largest hole) —
   new fx-import-invalid: seven codes in one sorted set, collision against
   a HELD id, atomicity over a rich payload.
6. Present-but-mistyped required fields → E_MISSING_FIELD unfixtured —
   fx-create-invalid (title: 9, at: 42).
7. Multi-edge dependsOn/links ordering unfixtured (id-order impostor
   survived) — fx-link now adds two edges in anti-id order.
8. $-token numbering ("counting neither failed creates nor idempotent
   hits") undiscriminated — fx-timestamp-bad gains a success-after-failures
   ($1, not $3); fx-linkage-idempotent a fresh create after hits ($2, not
   $4); new criterion ac-ts-normalization carries both.

All eight NITs folded too (unknown $-token referent, non-string close
reason, mistyped optionals, set absent/non-object, claim-closed +
reopen-in_progress, priority boundary 4 / -1 / "high", parent-unknown
co-fire, taskRef-tertiary-vacuous note in it-ts-query).

Corpus after round 1: 8 items, 35 criteria, 38 fixtures. Implementation
(written against the draft while the reviewer ran) passed all amended
fixtures without change — the co-fire semantics it implemented were the
ones ratified.

## Cold review round 2 — REWORK (2026-06-12)

All 38 traced clean; round-1 discrimination fixes confirmed; no dead
weight. Three MAJORs:

1. **actor required-ness entirely uncarried** — every mutation in the
   corpus carried actor: "art"; an actor-optional implementation passed all
   38. fx-create-invalid now pins absent actor, numeric actor (co-fired
   with E_BAD_PRIORITY).
2. **Prose↔fixture contradiction on mistyped referents** — fx-create-invalid
   expected E_BAD_FIELD alone for parent: 42 while it-ts-model's "always
   well-posed" existence check implied co-firing E_UNKNOWN_ID. Resolved in
   the body: existence checks are well-posed over STRING-valued referent
   fields only — no lookup on a non-string. (The fixture was right; the
   prose now says why.)
3. **create-parent × linkage-idempotency composition undefined** — resolved:
   VALIDATION PRECEDES IDEMPOTENCY (unknown parent refuses outright even on
   a held key), and a clean hit discards the proposal whole, parent edge
   included. New fixture fx-linkage-parent pins both paths on an
   in_progress holder (also closing the NIT about the three-status
   enumeration).

All eight NITs folded: bad at on link/comment/update (incl. the
E_BAD_TIMESTAMP+E_CYCLE co-fire), unknown ids on update/close/reopen,
list filters in_progress/closed, mistyped specItemRef/criterionId,
lowercase t/z designators stored verbatim, import siblings (within-payload
linkage collision, malformed comment at, dependsOn as forbidden task-record
key, self-link in import links → E_CYCLE — fx-import-invalid now reports
nine codes in one sorted set), and the vacuous tasks/links neutral-on-error
clause removed (export cannot error).

Corpus after round 2: 8 items, 35 criteria, 39 fixtures. Implementation
unchanged again — both MAJOR semantic resolutions matched what it already
did.

## Cold review round 3 — REWORK (2026-06-12)

All 39 traced clean. Two MAJORs, both coverage gaps at load-bearing joints:

1. **The (specItemRef, ⊥) key never self-collided** — no fixture replayed a
   criterion-less spec-linked create, so "absent criterionId is a key
   value" was indistinguishable from "no criterionId means no key" — and
   the latter breaks exactly the item-level propose-idempotency that the
   native-felag-tasks goal rests on. fx-linkage-distinct now replays the
   keyless key (HIT) and contrasts two no-specItemRef creates (distinct).
2. **E_HAS_PARENT × E_CYCLE co-fire reachable but unordered** — the
   duplicate-detection carve-out proved referent checks CAN suppress each
   other, leaving this pair ambiguous. Pinned: they CO-FIRE (only duplicate
   detection suppresses); fx-link-parent now carries the re-parent+cycle
   link → sorted pair.

All nine NITs folded: at absent on create, comment text mistyped, import
bare-record (all required fields absent at once), import link E_BAD_TYPE +
E_HAS_PARENT (fx-import-invalid now reports ALL TEN error codes in one
sorted set — every code in the contract except E_BAD_TRANSITION, which
cannot arise in import), malformed import comment missing actor/text,
import envelope actor/at requiredness stated and fixtured, update set
mixing a valid key with a foreign key, ready-after-comment perturbation
check, and the vacuous report-taskRef tertiary key ceded as a named
preamble residue exclusion.

Corpus after round 3: 8 items, 35 criteria, 39 fixtures (two extended, none
added — coverage went into existing sequences). Implementation unchanged a
third time.

## Cold review round 4 — REWORK (2026-06-12)

All 39 traced clean, including the subtle E_HAS_PARENT derivation through
an invalid payload record's id. Three MAJORs:

1. **Attribution provenance undiscriminated** — every create and claim in
   the corpus carried actor "art", so a hardcoded createdBy/assignee passed
   everything. fx-claim now creates as art and claims as jonathan;
   fx-create-defaults creates as jonathan and reads createdBy back.
2. **create's parent shortcut never met link's invariants** — a side-field
   parent implementation that link never consults passed all 39.
   fx-create-parent now drives link against the create-set edge:
   re-parent → E_HAS_PARENT, identical re-link → no-op, cycle through it →
   E_CYCLE.
3. **Import-envelope E_BAD_TIMESTAMP uncarried** — only the
   E_MISSING_FIELD half was fixtured. fx-import-invalid now sends a valid
   payload under an offsetless envelope at → E_BAD_TIMESTAMP, imported 0.

NITs folded: key-presence (not value-validity) wording for the lone
criterionId rule; import payload order now reverse-id in fx-import and
fx-roundtrip (an id-sorting importer diverges); assignee/description
non-string in update set.

Corpus after round 4: 8 items, 35 criteria, 39 fixtures. Implementation
unchanged a fourth time.

## Cold review round 5 — REWORK (2026-06-12)

All 39 traced clean; "fix the two MAJORs (one fixture each) and this is a
MERGE." Both folded:

1. **Field-error half of validation-precedes-idempotency uncarried** — a
   short-circuit-to-hit implementation (held key skips field validation)
   passed the corpus. fx-linkage-idempotent now replays the held key with
   priority 9 → error envelope, never a hit. The it-ts-model wording that
   listed linkage idempotency among co-firing referent checks was the last
   trace of the round-1 contradiction — reworded: duplicate detection and
   idempotency are SUCCESS paths reached only by clean commands.
2. **Import startedAt/closedAt parseability never isolated** — a
   createdAt-and-comments-only parser passed. New import op whose record's
   ONLY defects are offsetless startedAt/closedAt → E_BAD_TIMESTAMP.

All six NITs folded: non-string list filter; reopen field-preservation
(description/legacyRef/priority/comments survive — only the claim/close
stamps are removed); import mistyped optionals; forbidden parent and
dependsOn keys on separate records; valid-empty import succeeds with
imported 0 and tasks-absent is E_MISSING_FIELD; update on an in_progress
task (also pins update-assignee overriding claim-assignee).

Corpus after round 5: 8 items, 35 criteria, 39 fixtures. Implementation
unchanged a fifth time.
