// taskstore as loom's tasks piece: `ui --json` sections (loom docs/extensions.md).
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uiSections } from "../src/loom-ui.js";

describe("uiSections", () => {
  it("counts, lists in-progress first, then ready by priority", () => {
    const out = uiSections(
      [{ id: "t-3", title: "low", priority: 3 }, { id: "t-2", title: "urgent", priority: 1 }],
      [{ id: "t-9", title: "doing", priority: 2, assignee: "art" }],
    );
    const [stats, doing, ready] = out.sections[0].blocks as Array<{ type: string; items: Array<Record<string, string>> }>;
    expect(stats.items.map((i) => i.value)).toEqual(["1", "2", "1"]);
    expect(stats.items[2].tone).toBe("warn");
    expect(doing.items[0]).toEqual({ text: "t-9 doing", meta: "in progress · p2 · art" });
    expect(ready.items.map((i) => i.text)).toEqual(["t-2 urgent", "t-3 low"]);
  });

  it("caps each list at 10 with an 'and N more' line", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `t-${i}`, title: "x", priority: 2 }));
    const blocks = uiSections(many, []).sections[0].blocks as Array<{ type: string; items?: unknown[]; text?: string }>;
    expect(blocks[1].items).toHaveLength(10);
    expect(blocks[2]).toEqual({ type: "text", text: "and 3 more" });
  });
});

describe("taskstore ui (the CLI verb)", () => {
  it("refuses, and creates nothing, when there's no store", { timeout: 60000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "taskstore-ui-"));
    // Built dist, like cli-binding.test.ts: what the installed launcher runs.
    const repo = join(__dirname, "..");
    spawnSync("npm", ["run", "build"], { cwd: repo, stdio: "pipe" });
    const r = spawnSync(process.execPath, [join(repo, "dist", "cli.js"), "ui", "--json"], {
      cwd: dir, encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "TASKSTORE_DB")),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no store at/);
    expect(existsSync(join(dir, ".taskstore"))).toBe(false);
  });
});
