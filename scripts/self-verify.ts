// The loop closes, twice: run BOTH fixture corpora through this
// implementation — spec/taskstore-core via the op-sequence runner, and
// felag's spec/felag-tasks via the TaskstoreWorkLayer — emit
// VerificationRecords with fixtureHash for every gating criterion,
// ingest-check each record, then ask felag verify for both verdicts.
// Pattern: watchdog-impl scripts/self-verify.ts (ceremony 1).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fixtureHash, ingest, parse, verify } from "felag";
import { runOps } from "../src/run-ops.js";
import { TaskstoreWorkLayer } from "../src/work-layer.js";
import type { Command } from "../src/core.js";

const IMPLEMENTATION = "taskstore-impl";
const IMPLEMENTATION_VERSION = "0.2.0";
const here = import.meta.dirname;
const at = new Date().toISOString();

interface Rec { record: string; id?: string; [k: string]: unknown }

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}
const eq = (a: unknown, b: unknown): boolean =>
  JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

// felag-tasks/op-sequence@0 runner over the WorkLayer (mirrors felag's
// tasks/run-ops.js: $-tokens by order of first appearance).
interface CtasksOp { op: string; proposal?: Record<string, unknown>; taskRef?: string; to?: string }
function runCtasksOps(ops: CtasksOp[]): unknown[] {
  const layer = new TaskstoreWorkLayer();
  const refToToken = new Map<string, string>();
  const tokenToRef = new Map<string, string>();
  const tokenize = (ref: string | null): string | null => {
    if (ref === null) return null;
    if (!refToToken.has(ref)) {
      const token = `$${refToToken.size + 1}`;
      refToToken.set(ref, token);
      tokenToRef.set(token, ref);
    }
    return refToToken.get(ref)!;
  };
  const results: unknown[] = [];
  for (const op of ops) {
    if (op.op === "propose") {
      const r = layer.propose(op.proposal ?? {});
      results.push({ ...r, taskRef: tokenize(r.taskRef) });
    } else if (op.op === "report") {
      const r = layer.report();
      results.push({ entries: r.entries.map((e) => ({ ...e, taskRef: tokenize(e.taskRef)! })) });
    } else if (op.op === "transition") {
      const ref = tokenToRef.get(op.taskRef ?? "") ?? op.taskRef ?? "";
      results.push(layer.transition(ref, op.to ?? ""));
    }
  }
  return results;
}

interface Unit {
  specDir: string;
  specName: string;
  format: string;
  run: (input: unknown) => unknown;
}

const units: Unit[] = [
  {
    specDir: join(here, "..", "spec", "taskstore-core"),
    specName: "taskstore-core",
    format: "taskstore/op-sequence@0",
    run: (input) => ({ results: runOps((input as { ops: Command[] }).ops) }),
  },
  {
    specDir: join(here, "..", "..", "felag", "spec", "felag-tasks"),
    specName: "felag-tasks",
    format: "felag-tasks/op-sequence@0",
    run: (input) => ({ results: runCtasksOps((input as { ops: CtasksOp[] }).ops) }),
  },
];

mkdirSync(join(here, "..", "verification"), { recursive: true });
let failed = false;

for (const unit of units) {
  const spec = parse(readFileSync(join(unit.specDir, "spec.jsonl"), "utf8")) as Rec[];
  const fixtures = parse(readFileSync(join(unit.specDir, "fixtures.jsonl"), "utf8")) as Rec[];
  const fixturesById = new Map(fixtures.map((f) => [f.id as string, f]));
  const conformanceVersion = (
    spec.find((r) => r.record === "preamble") as { conformanceVersion: string }
  ).conformanceVersion;

  const runFixture = (fx: Rec): "pass" | "fail" => {
    try {
      if (fx.format !== unit.format) return "fail";
      return eq(unit.run(fx.input), fx.expected) ? "pass" : "fail";
    } catch {
      return "fail";
    }
  };

  const records: Record<string, unknown>[] = [];
  for (const r of spec) {
    if (r.record !== "criterion") continue;
    for (const fxId of r.fixtures as string[]) {
      const fx = fixturesById.get(fxId);
      if (!fx) continue;
      records.push({
        criterionId: r.id,
        fixtureId: fxId,
        fixtureHash: fixtureHash(fx),
        implementation: IMPLEMENTATION,
        implementationVersion: IMPLEMENTATION_VERSION,
        conformanceVersion,
        verdict: runFixture(fx),
        evidence: `scripts/self-verify.ts fixture run at ${at}`,
        runner: "taskstore-impl/self-verify",
        at,
        attribution: "art@one self-verify",
      });
    }
  }

  for (const rec of records) {
    const res = ingest(rec) as { accepted: boolean; errors: unknown[] };
    if (!res.accepted) {
      console.error("ingest rejected:", JSON.stringify(res.errors), JSON.stringify(rec));
      process.exit(1);
    }
  }

  const report = verify({
    spec: [...spec, ...fixtures],
    records,
    implementation: IMPLEMENTATION,
    asOf: at,
  } as never);

  writeFileSync(
    join(here, "..", "verification", `${IMPLEMENTATION}-vs-${unit.specName}.jsonl`),
    records.map((r) => JSON.stringify(sortKeys(r))).join("\n") + "\n",
  );
  writeFileSync(
    join(here, "..", "verification", `${IMPLEMENTATION}-vs-${unit.specName}-report.json`),
    JSON.stringify(sortKeys(report), null, 2) + "\n",
  );

  const rep = report as { verdict: string; failing: string[]; waived: string[]; disputed: string[] };
  console.log(
    `${IMPLEMENTATION} ${IMPLEMENTATION_VERSION} vs ${unit.specName} ${conformanceVersion}: ` +
      `${rep.verdict.toUpperCase()} (records ${records.length}, failing ${rep.failing.length}, ` +
      `waived ${rep.waived.length}, disputed ${rep.disputed.length})`,
  );
  if (rep.failing.length) {
    console.error("failing:", rep.failing.join(", "));
    failed = true;
  }
}

if (failed) process.exit(1);
