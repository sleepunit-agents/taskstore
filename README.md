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

On loom's page (`/ui`) it adds the Tasks tab, the Work tile on Home, and the
owner's tasks under "Your call", by answering `loom-tasks ui --json`,
`ui page --json` and `ui act --json` (page contract v2, `src/loom-ui.ts`).
It reads `TASKSTORE_DB` (which must already exist), `TASKSTORE_OWNER` (whose
call an ask is and who a comment from the page is posted as; unset, there are
no asks and comments are posted as `loom-page`) and `TZ` for dates.

In a loom project's hub it adds the Tasks section: `loom-tasks project-feed
--json` (declared as the package's `loom.sections.project`, `src/project-feed.ts`)
answers the `--epic` task's tree in four groups (waiting on the owner, ready,
blocked, done since `--since`), plus open tasks outside the tree that name the
project, each item citing any `dg-…` conversation digest its description does.
Given `--conversation <cv>` (loom passes one per Comms thread filed under the
project), tasks made in those threads join the project's tree.

In a loom Comms thread it adds the thread's tasks to "Work in this thread":
`loom-tasks thread-feed --json --conversation <cv> [--ref <ref>]…` (declared as
`loom.sections.thread`, `src/thread-feed.ts`) answers each `t-N` the thread
named and each task made in it, with its state in words. A task made in a
thread carries `source: "conversation:<cv>"` (taskstore-core's `it-ts-source`):
`--source` on `create` and `update` sets it, and without it a body that has
`LOOM_BODY_CONVERSATION` in its environment gives that conversation to a create,
and to an update of a task with no source yet. loom's `run` API carries no
environment, so a body in a house passes `--source` itself. The task's page
shows where it came from with a `from` block, which loom draws per viewer.

Over loom's piece API (`POST /api/tasks/run`, body `{"argv": ["ready"]}`) a body
that isn't on loom's machine, such as a house, runs any CLI command against the
one store and gets back `{exit, stdout, stderr}`: the same JSON and exit codes
as locally (`src/loom-api.ts`). It runs as loom's resolved caller: the owner (as
`TASKSTORE_OWNER`), or an agent named in `TASKSTORE_AGENTS`, as that agent.
Nobody else gets in, and `import` (which reads a file on loom's machine) stays local.

## Plain words

Every task can say what it's for in words a person reads: `--goal` (what's
true when it's done), `--why` and `--done-when`. A task that needs the owner
also carries the ask: `--ask` (one plain question), `--if-yes`, `--if-no` and
`--answers yes-no|words`. They're fields on the task (`spec/taskstore-core`,
it-ts-plain), on `create` and `update`; `""` clears one.

```bash
taskstore create "Back up the photos offsite" \
  --goal "Every photo has a copy off this machine." --why "One disk failure would lose them all."
taskstore update t-1273 --assignee jonathan \
  --ask "Can you get the old Station 13 hotspot onto a bench I can reach?" \
  --if-yes "I test it and report what's wrong." --if-no "I close this."
```

The CLI lints the title, goal and ask (`src/plain.ts`): no ids, lane or wake
words, round numbers, site codes or a leading `tag:`. The owner's task
(`TASKSTORE_OWNER`, else `jonathan`) is refused (`E_NOT_PLAIN`, exit 1, with
the plain form to retry in) until it reads plainly and has an ask. Any other
task is written anyway, with `warnings` in the answer and on stderr.

On loom's page the ask is the Inbox item's headline, with its why under it;
the task page leads with Ask, Why, If yes and If no, then the goal, with the
description folded under Background. The owner answers with Yes or No, or in
their own words, in one form: the answer is their comment, the task goes back
to the agent that asked (`askedBy`, else the first of `TASKSTORE_AGENTS`, else
`art`), and `TASKSTORE_ON_OWNER_COMMENT` wakes it.

## Several writers at once

Agents and lanes write the one store in parallel. Each mutation is one SQLite
write transaction (`BEGIN IMMEDIATE`): it takes the write lock, reads the
store, applies the core and writes back, mirror and interactions line
included, so it always builds on the last committed write. A writer waits up
to 30 s for the lock. A write that can't be applied (the lock never came, the
disk is full, the mirror couldn't be written) rolls back and answers
`ok: false` with `E_STORE`, exit 1; it is never acknowledged. The contract
says so in it-ts-durable (`spec/taskstore-core` 0.6.0), proven by
`fx-concurrent-writers`: 8 processes at once, 100 writes each, nothing
acknowledged is lost. Before this (t-1831) the binding read outside the
transaction and lost 442 of 773 acknowledged writes in that test.
`npx tsx scripts/concurrent-bench.ts 8 100 store|cli` counts them by hand.

Born in felag ceremony 2 (art-ubo.6, 2026-06-12).
