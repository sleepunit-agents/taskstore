// felag-tasks conformance: the SAME c-tasks fixture corpus the reference
// implementation and the beads shim run, over the TaskstoreWorkLayer — the
// harness pattern of felag-ts test/tasks-shim-beads.test.ts. The op runner
// here mirrors felag's tasks/run-ops.js (felag-tasks/op-sequence@0 $-token
// normalization by order of first appearance).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskstoreWorkLayer } from "../src/work-layer.js";

interface Op {
  op: "propose" | "report" | "transition";
  proposal?: Record<string, unknown>;
  taskRef?: string;
  to?: string;
}

interface Fixture {
  id: string;
  description: string;
  format: string;
  input: { ops: Op[] };
  expected: { results: unknown[] };
}

function runOps(ops: Op[], layer: TaskstoreWorkLayer): unknown[] {
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
    switch (op.op) {
      case "propose": {
        const r = layer.propose(op.proposal ?? {});
        results.push({ ...r, taskRef: tokenize(r.taskRef) });
        break;
      }
      case "report": {
        const r = layer.report();
        results.push({ entries: r.entries.map((e) => ({ ...e, taskRef: tokenize(e.taskRef)! })) });
        break;
      }
      case "transition": {
        const ref = tokenToRef.get(op.taskRef ?? "") ?? op.taskRef ?? "";
        results.push(layer.transition(ref, op.to ?? ""));
        break;
      }
    }
  }
  return results;
}

const dir = join(__dirname, "..", "..", "felag", "spec", "felag-tasks");
const fixtures = readFileSync(join(dir, "fixtures.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Fixture);

describe("felag-tasks fixture corpus (taskstore layer)", () => {
  for (const fx of fixtures) {
    it(`${fx.id} — ${fx.description.slice(0, 60)}`, () => {
      expect(fx.format).toBe("felag-tasks/op-sequence@0");
      expect(runOps(fx.input.ops, new TaskstoreWorkLayer())).toEqual(fx.expected.results);
    });
  }
});
