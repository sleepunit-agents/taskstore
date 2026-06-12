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
