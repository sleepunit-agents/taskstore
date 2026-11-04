// The taskstore/concurrent-writers@0 runner (ac-ts-no-lost-writes): seeds a
// temp store, starts `writers` processes at once, each running its own
// sequence of comment/update/close writes, then reads the store back and
// lists every write the store ACKNOWLEDGED (ok true) that isn't in it.
//
// Every write is checkable on its own, so a lost one can be named:
//   comment — on one of a few SHARED tasks (all writers hit the same rows);
//             each text is unique, so it must be there exactly once.
//   update  — on the writer's OWN task; a writer's writes are sequential,
//             so its last acknowledged description is the one that stands.
//   close   — the writer's own tasks, one close each, reason unique.
// A binding that loads state outside its write transaction and writes the
// whole state back loses the others' writes to its stale copy — which is
// what t-1831 measured on the live store (~20 of ~450, 2026-11-04).

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/sqlite-store.js";
import type { Task, Link } from "../src/core.js";

export interface ConcurrentInput {
  writers: number;
  opsPerWriter: number;
  sharedTasks: number;
}

export interface ConcurrentOutcome {
  /** Writes the store acknowledged (ok true) that it doesn't hold. */
  lost: string[];
  /** The passive JSONL mirror says exactly what export says. */
  mirrorMatchesStore: boolean;
  /** One interactions line per acknowledged write (and per seed create). */
  interactionsMatchAcks: boolean;
  acknowledged: number;
  refused: number;
  /** Why the refused writes were refused, distinct reasons. */
  refusals: string[];
  total: number;
}

interface PlannedOp { kind: "comment" | "update" | "close"; id: string; value: string }

const AT = "2026-11-04T18:00:00.000Z";

export function runConcurrentWriters(input: ConcurrentInput, mode: "store" | "cli"): Promise<ConcurrentOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "taskstore-concurrent-"));
  const dbPath = join(dir, "store.db");
  const seed = new SqliteStore(dbPath);
  const mk = (title: string) => seed.run({ op: "create", title, actor: "seed", at: AT }).id as string;
  const shared = Array.from({ length: input.sharedTasks }, (_, i) => mk(`shared ${i}`));
  const writers: PlannedOp[][] = [];
  for (let w = 0; w < input.writers; w++) {
    const own = mk(`writer ${w}`);
    const ops: PlannedOp[] = [];
    for (let i = 0; i < input.opsPerWriter; i++) {
      const value = `w${w}-i${i}`;
      const kind = (["comment", "update", "close"] as const)[i % 3];
      const id = kind === "comment" ? shared[(w + i) % shared.length] : kind === "update" ? own : mk(`w${w} close ${i}`);
      ops.push({ kind, id, value });
    }
    writers.push(ops);
  }
  const seeded = (seed.run({ op: "export" }).tasks as Task[]).length;
  seed.close();
  const planPath = join(dir, "plan.json");
  writeFileSync(planPath, JSON.stringify({ dbPath, writers }));

  const writer = join(import.meta.dirname, "support", "concurrent-writer.mjs");
  const runs = writers.map((_, w) => new Promise<string>((resolve, reject) => {
    execFile("node", [writer, planPath, String(w), mode], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`writer ${w}: ${err.message}\n${stderr}`)) : resolve(stdout));
  }));

  return Promise.all(runs).then((outs) => {
    const reports = outs.flatMap((o) => o.split("\n").filter(Boolean).map((l) => JSON.parse(l) as PlannedOp & { ok: unknown }));
    const store = new SqliteStore(dbPath);
    const exported = store.run({ op: "export" }) as unknown as { tasks: Task[]; links: Link[] };
    store.close();
    const byId = new Map(exported.tasks.map((t) => [t.id, t]));

    const lost: string[] = [];
    const lastUpdate = new Map<string, string>();
    for (const r of reports) {
      if (r.ok !== true) continue;
      const t = byId.get(r.id);
      if (r.kind === "comment") {
        const n = (t?.comments ?? []).filter((c) => c.text === r.value).length;
        if (n !== 1) lost.push(`comment ${r.value} on ${r.id} (held ${n}×)`);
      } else if (r.kind === "close") {
        if (t?.status !== "closed" || t.closeReason !== r.value) lost.push(`close ${r.value} of ${r.id} (${t?.status}, ${t?.closeReason})`);
      } else {
        lastUpdate.set(r.id, r.value); // reports keep each writer's order
      }
    }
    for (const [id, value] of lastUpdate) {
      const held = byId.get(id)?.description;
      if (held !== value) lost.push(`update ${value} of ${id} (holds ${held})`);
    }

    const mirror = readFileSync(join(dir, "store.export.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const fromStore = [
      ...exported.tasks.map((t) => ({ record: "task", ...t })),
      ...exported.links.map((l) => ({ record: "link", ...l })),
    ];
    const acknowledged = reports.filter((r) => r.ok === true).length;
    const interactions = readFileSync(join(dir, "store.interactions.jsonl"), "utf8").split("\n").filter(Boolean).length;
    return {
      lost,
      mirrorMatchesStore: JSON.stringify(mirror) === JSON.stringify(fromStore),
      interactionsMatchAcks: interactions === seeded + acknowledged,
      acknowledged,
      refused: reports.length - acknowledged,
      refusals: [...new Set(reports.filter((r) => r.ok !== true).map((r) => String(r.ok)))],
      total: reports.length,
    };
  });
}
