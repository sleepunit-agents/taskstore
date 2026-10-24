# taskstore

Art's first-party work store — the thing that replaced beads.

- `spec/taskstore-core/` — the contract, in felag interchange: pure
  transitions over (state, command), proven by op-sequence fixtures.
  `docs/interview.md` is the authoring record.
- `src/` — the reference implementation (TypeScript, better-sqlite3 binding).
- `verification/` — conformance ledgers: taskstore-impl vs taskstore-core
  AND vs felag-tasks (the c-tasks contract), per felag-core's verify.
- `scripts/build-spec.mjs` — the spec is authored as code and emitted
  canonically through the felag library; never edit the JSONL by hand.

It's also loom's `tasks` piece: the package installs the CLI as both
`taskstore` and `loom-tasks`, so `loom tasks ready` reaches it through loom's
command namespace ([loom `docs/extensions.md`](https://github.com/sleepunit-agents/loom/blob/main/docs/extensions.md)).
The role's contract is `spec/taskstore-core`. Another implementation that
conforms to it can install its own `loom-tasks` instead.

Born in felag ceremony 2 (art-ubo.6, 2026-06-12).
