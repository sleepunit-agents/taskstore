// `taskstore bundle export|import`: the tasks piece's part of loom's household
// bundle (loom docs/extensions.md, "The bundle: a piece's part"). The whole
// store (tasks, comments, links, history), encrypted by the piece to the
// owner's recipients; on import, written where TASKSTORE_DB says, never over
// a store that's already there.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const repo = join(__dirname, "..");
const cli = join(repo, "dist", "cli.js");
const hasAge = spawnSync("sh", ["-c", "command -v age && command -v age-keygen"]).status === 0;

describe.skipIf(!hasAge)("taskstore bundle", () => {
  let dir: string;
  beforeAll(() => {
    execFileSync("npx", ["tsc"], { cwd: repo });
    dir = mkdtempSync(join(tmpdir(), "taskstore-bundle-"));
  });
  const run = (args: string[], env: Record<string, string>, input?: string) =>
    spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  it("round-trips the whole store, encrypted, and never writes over one that's there", () => {
    const db = join(dir, "live.db");
    const created = JSON.parse(run(["create", "zebra kiln audit"], { TASKSTORE_DB: db }).stdout);
    const id = created.task?.id ?? created.id;
    run(["comment", id, "the glaze is iambic"], { TASKSTORE_DB: db });
    const key = join(dir, "owner.key");
    execFileSync("age-keygen", ["-o", key], { stdio: "ignore" });
    const recipient = execFileSync("age-keygen", ["-y", key], { encoding: "utf8" }).trim();

    expect(run(["bundle", "export"], { TASKSTORE_DB: db, LOOM_EXPORT_RECIPIENTS: "" }).status).not.toBe(0);
    const part = run(["bundle", "export"], { TASKSTORE_DB: db, LOOM_EXPORT_RECIPIENTS: recipient });
    expect(part.status, part.stderr).toBe(0);
    expect(part.stdout.startsWith("-----BEGIN AGE ENCRYPTED FILE-----")).toBe(true);
    expect(part.stdout).not.toContain("zebra");

    expect(run(["bundle", "import"], { TASKSTORE_DB: db, LOOM_IMPORT_IDENTITY: key }, part.stdout).status).not.toBe(0);
    const fresh = join(dir, "restored", "store.db");
    const r = run(["bundle", "import"], { TASKSTORE_DB: fresh, LOOM_IMPORT_IDENTITY: key }, part.stdout);
    expect(r.status, r.stderr).toBe(0);
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
    const shown = run(["show", id], { TASKSTORE_DB: fresh }).stdout;
    expect(shown).toContain("zebra kiln audit");
    expect(shown).toContain("the glaze is iambic");
  });
});
