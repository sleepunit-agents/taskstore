# Deployment — the ~/Art binding

- **Store**: `~/Art/.taskstore/store.db` (SQLite, WAL). The CLI defaults to
  `./.taskstore/store.db` relative to cwd, so anything running in ~/Art —
  lanes, ceremonies, Jonathan — hits the same store with no configuration.
- **Exit door**: `~/Art/.taskstore/store.export.jsonl`, rewritten atomically
  on every mutation by the binding (write-through, never periodic). One
  `record: task` line per task, then one `record: link` line per edge.
- **CLI**: `~/.local/bin/taskstore` → `node ~/Code/taskstore/dist/cli.js`.
  JSON out, exit 0/1. `TASKSTORE_ACTOR` overrides attribution (default
  `art`); `TASKSTORE_DB` overrides the store path.
- **felag audit**: `felag audit <spec> <ledger> <impl> --store taskstore`
  drives the store through the c-tasks WorkLayer (`TaskstoreWorkLayer`).
- **beads**: frozen read-only after the 2026-06-12 migration (art-ubo.6).
  Data intact at `~/Art/.beads/`; do not write to it. Every bd issue was
  imported with its id preserved and `legacyRef: beads:<id>`.
