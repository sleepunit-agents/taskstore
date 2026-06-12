// Migration: live `bd export` (the complete source — the passive
// .beads/issues.jsonl mirror was probed stale and lossy, 2026-06-12) into a
// taskstore import payload, applied through the contract's own import op.
// Read-only on the bd side. Ids are preserved literally; legacyRef records
// provenance ("beads:<id>").
//
// Usage: tsx scripts/migrate-from-beads.ts <beads-workspace-dir> <out-state.json>
//   Emits the resulting StoreState JSON to <out-state.json>, plus a parity
//   check: counts by status/type, and ready-queue comparison data.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { apply, emptyState, type Command } from "../src/core.js";

interface BdComment {
  author?: string;
  text: string;
  created_at: string;
}

interface BdDep {
  issue_id: string;
  depends_on_id: string;
  type: string;
}

interface BdIssue {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: number;
  issue_type: string;
  assignee?: string;
  owner?: string;
  created_at: string;
  created_by?: string;
  started_at?: string;
  closed_at?: string;
  close_reason?: string;
  notes?: string;
  comments?: BdComment[];
  dependencies?: BdDep[];
}

const [, , beadsDir, outPath] = process.argv;
if (!beadsDir || !outPath) {
  console.error("usage: tsx scripts/migrate-from-beads.ts <beads-dir> <out-state.json>");
  process.exit(1);
}

const TYPE_MAP: Record<string, string> = {
  task: "task",
  bug: "bug",
  feature: "feature",
  epic: "epic",
  chore: "task", // taskstore-core has no chore; provenance keeps the truth
};
const STATUS_OK = new Set(["open", "in_progress", "closed"]);
const LINK_OK = new Set(["blocks", "parent-child"]);

const raw = execFileSync("bd", ["-C", beadsDir, "export"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const issues = raw
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as BdIssue);

const now = new Date().toISOString();
const tasks: Record<string, unknown>[] = [];
const links: Record<string, unknown>[] = [];
const skippedDeps: BdDep[] = [];

for (const i of issues) {
  const t: Record<string, unknown> = {
    id: i.id,
    title: i.title,
    type: TYPE_MAP[i.issue_type] ?? "task",
    status: STATUS_OK.has(i.status) ? i.status : "open",
    priority: Math.min(4, Math.max(0, i.priority)),
    createdAt: i.created_at,
    createdBy: i.created_by ?? i.owner ?? "art",
    legacyRef: `beads:${i.id}`,
    comments: (i.comments ?? []).map((c) => ({
      actor: c.author ?? "art",
      at: c.created_at,
      text: c.text,
    })),
  };
  if (i.description) t.description = i.description;
  if (i.assignee) t.assignee = i.assignee;
  if (i.started_at) t.startedAt = i.started_at;
  if (i.closed_at) t.closedAt = i.closed_at;
  if (i.close_reason) t.closeReason = i.close_reason;
  if (i.notes)
    (t.comments as unknown[]).push({ actor: "art", at: i.created_at, text: `[migrated bd notes] ${i.notes}` });
  tasks.push(t);

  for (const d of i.dependencies ?? []) {
    if (!LINK_OK.has(d.type)) {
      skippedDeps.push(d);
      continue;
    }
    links.push({ id: d.issue_id, dependsOn: d.depends_on_id, type: d.type });
  }
}

const importCmd: Command = { op: "import", actor: "art", at: now, tasks, links };
const { result, state } = apply(emptyState(), importCmd);
if (result.ok !== true) {
  console.error("import REFUSED:", JSON.stringify(result.errors));
  process.exit(1);
}

writeFileSync(outPath, JSON.stringify(state, null, 2) + "\n");

// Parity evidence.
const byStatus: Record<string, number> = {};
for (const t of state.tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
const ready = apply(state, { op: "ready" }).result.entries as { id: string }[];
console.log(`imported ${result.imported} tasks, ${links.length} links (skipped deps: ${skippedDeps.length})`);
console.log(`status counts: ${JSON.stringify(byStatus)}`);
console.log(`ready queue (${ready.length}): ${ready.map((e) => e.id).join(", ")}`);
if (skippedDeps.length) console.log("skipped:", JSON.stringify(skippedDeps));
