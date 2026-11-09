// A loom piece is installed straight from a GitHub commit
// (`npm install github:sleepunit-agents/taskstore#<sha>`). npm prepares a git
// dependency by running `npm install --include=dev` in a temporary clone, so
// every dependency, dev ones included, must resolve from that clone alone. A
// `file:../felag` devDependency made the supported install fail with ENOENT
// on <npm cache>/_cacache/tmp/felag/package.json (t-2040).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (f: string) => JSON.parse(readFileSync(join(root, f), "utf-8"));
const LOCAL = /^(file:|link:|\.{0,2}\/)/;

describe("installable from a git commit alone", () => {
  it("package.json depends on nothing outside the clone", () => {
    const pkg = read("package.json");
    const outside: string[] = [];
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, spec] of Object.entries((pkg[section] ?? {}) as Record<string, string>)) {
        if (LOCAL.test(spec)) outside.push(`${section}.${name}: ${spec}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it("package-lock.json links nothing outside the clone", () => {
    const lock = read("package-lock.json");
    const outside = Object.entries(lock.packages as Record<string, { link?: boolean; resolved?: string }>)
      .filter(([key, p]) => key.startsWith("../") || p.link || (p.resolved && LOCAL.test(p.resolved)))
      .map(([key]) => key);
    expect(outside).toEqual([]);
  });
});
