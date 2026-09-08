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
    .map((l) => JSON.parse(l) as { record: string; id?: string; fixtures?: string[] });
  const criteria = spec.filter((r) => r.record === "criterion");
  const cited = new Set(criteria.flatMap((c) => c.fixtures ?? []));
  const held = new Set(fixtures.map((f) => f.id));

  it("every fixture is cited by some criterion", () => {
    expect([...held].filter((id) => !cited.has(id))).toEqual([]);
  });

  it("every cited fixture exists in the corpus", () => {
    expect([...cited].filter((id) => !held.has(id))).toEqual([]);
  });
});
