// The conformance harness: spec/taskstore-core/fixtures.jsonl IS the test
// suite — the watchdog-core / felag-ts conformance.test.ts pattern.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runOps } from "../src/run-ops.js";
import type { Command } from "../src/core.js";

interface Fixture {
  record: "fixture";
  id: string;
  contractId: string;
  description: string;
  format: string;
  input: { ops: Command[] };
  expected: { results: unknown[] };
}

const dir = join(__dirname, "..", "spec", "taskstore-core");
const fixtures = readFileSync(join(dir, "fixtures.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Fixture);

describe("taskstore-core fixture corpus", () => {
  it("loads the full corpus", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fx of fixtures) {
    it(`${fx.id} — ${fx.description.slice(0, 70)}`, () => {
      expect(fx.format).toBe("taskstore/op-sequence@0");
      expect(runOps(fx.input.ops)).toEqual(fx.expected.results);
    });
  }
});

// The corpus is run by file, so a fixture bound to no criterion passes green
// and proves nothing about the contract — it is evidence for a claim nobody
// made. That is not hypothetical: fx-unclaim and fx-unclaim-bad shipped that
// way and went unnoticed until 2026-09-08, because every signal the suite
// produced was a pass. These two tests close the loop in both directions.
describe("spec/fixture binding", () => {
  const spec = readFileSync(join(dir, "spec.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { record: string; id?: string; class?: string; fixtures?: string[] });
  const criteria = spec.filter((r) => r.record === "criterion");
  const cited = new Set(criteria.flatMap((c) => c.fixtures ?? []));
  const held = new Set(fixtures.map((f) => f.id));

  it("every fixture is cited by some criterion", () => {
    expect([...held].filter((id) => !cited.has(id))).toEqual([]);
  });

  it("every cited fixture exists in the corpus", () => {
    expect([...cited].filter((id) => !held.has(id))).toEqual([]);
  });

  // The direction that matters more, and the one the first two miss: a
  // criterion citing NOTHING is a claim with no evidence at all — worse than
  // a fixture nobody claims, since the orphan fixture at least still runs.
  // `c.fixtures ?? []` means such a criterion contributes nothing to `cited`
  // and trips neither check above.
  //
  // The split is exact, not a convention to be kept by hand: a behavioral
  // criterion asserts a transition and is provable, so it MUST cite; a
  // judgment criterion (ac-ts-id-shape, ac-ts-loom-boundary) asserts a
  // refusal no op-sequence can witness, so it must NOT pretend to evidence.
  // Both directions, because a judgment criterion citing fixtures is the
  // same lie told the other way round.
  it("behavioral criteria cite fixtures and judgment criteria do not", () => {
    const wrong = criteria.filter(
      (c) => ((c.fixtures ?? []).length > 0) !== (c.class === "behavioral"),
    );
    expect(wrong.map((c) => `${c.id} (${c.class})`)).toEqual([]);
  });

  // Fixture ids collapse into `held` as a Set, so a duplicate id would shadow
  // a real fixture and vanish from both checks without failing either.
  it("fixture ids are unique", () => {
    const ids = fixtures.map((f) => f.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});
