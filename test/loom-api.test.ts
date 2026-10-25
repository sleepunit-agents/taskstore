// taskstore over loom's piece API (src/loom-api.ts): who may run a command,
// as whom, and what a remote command can't reach. Through the built CLI, as
// loom-http runs it: `taskstore api --json` with the request on stdin.

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const cli = join(__dirname, "..", "dist", "cli.js");
let db: string;

function api(request: unknown, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [cli, "api", "--json"], {
    input: typeof request === "string" ? request : JSON.stringify(request),
    env: { PATH: process.env.PATH ?? "", TASKSTORE_DB: db, TASKSTORE_AGENTS: "art", ...env },
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as { status: number; body: Record<string, unknown> };
}
const art = { kind: "agent", agent: "art" };
const run = (argv: string[], caller: unknown = art, env?: Record<string, string>) => api({ caller, path: "run", body: { argv } }, env);
const out = (b: Record<string, unknown>) =>
  JSON.parse(typeof b.stdout === "string" ? b.stdout : gunzipSync(Buffer.from(String(b.stdoutGz), "base64")).toString());

beforeAll(() => {
  db = join(mkdtempSync(join(tmpdir(), "ts-api-")), "store.db");
  const r = spawnSync(process.execPath, [cli, "create", "seed"], { env: { PATH: process.env.PATH ?? "", TASKSTORE_DB: db } });
  expect(r.status).toBe(0);
});

describe("taskstore api", () => {
  it("runs a command as the calling agent, with the CLI's own output and exit code", () => {
    const made = run(["create", "from a house", "--description", "d"]);
    expect(made.status).toBe(200);
    expect(made.body.exit).toBe(0);
    const id = out(made.body).id as string;
    expect(out(run(["show", id]).body).task.title).toBe("from a house");
    // unlink of an edge that isn't there: valid, nothing removed, exit 3.
    const miss = run(["unlink", id, "t-1", "--type", "blocks"]);
    expect(miss.status).toBe(200);
    expect(miss.body.exit).toBe(3);
    // A bad flag: usage, exit 2, the CLI's own words on stderr.
    const bad = run(["list", "--bogus", "x"]);
    expect(bad.body.exit).toBe(2);
    expect(String(bad.body.stderr)).toContain("--bogus");
  });

  it("takes the actor from loom's caller, never from the request", () => {
    // fez, not art: art is the CLI's own default actor, so it would prove nothing.
    const env = { TASKSTORE_AGENTS: "art,fez", TASKSTORE_ACTOR: "art" };
    const fez = { kind: "agent", agent: "fez" };
    const made = api({ caller: fez, path: "run", body: { argv: ["create", "who"], actor: "jonathan" } }, env);
    const id = out(made.body).id as string;
    expect(run(["comment", id, "hi"], { kind: "owner" }, { TASKSTORE_OWNER: "jonathan" }).body.exit).toBe(0);
    expect(run(["comment", id, "yo"], { kind: "owner" }).body.exit).toBe(0);
    const t = out(run(["show", id]).body).task;
    expect(t.createdBy).toBe("fez");
    expect(t.comments.map((c: { actor: string }) => c.actor)).toEqual(["jonathan", "owner"]);
  });

  it("refuses an agent this store isn't for, a box, and a caller loom didn't name", () => {
    expect(run(["ready"], { kind: "agent", agent: "mark" }).status).toBe(403);
    expect(run(["ready"], { kind: "piece", subject: "box/thor" }).status).toBe(403);
    expect(run(["ready"], null).status).toBe(403);
    expect(run(["ready"], art, { TASKSTORE_AGENTS: "" }).status).toBe(403);
  });

  it("won't read files on loom's machine or reach the loom-facing verbs", () => {
    for (const v of ["import", "api", "ui"]) expect(run([v, "/etc/passwd"]).status).toBe(403);
    expect(run([]).status).toBe(400);
    expect(api({ caller: art, path: "run", body: { argv: [1] } }).status).toBe(400);
    expect(api({ caller: art, path: "other", body: { argv: ["ready"] } }).status).toBe(404);
    expect(api("not json").status).toBe(400);
  });

  it("gzips a big answer to stay under loom's per-answer limit", () => {
    const long = "x".repeat(60_000);
    for (let i = 0; i < 6; i++) run(["create", `big ${i}`, "--description", long]);
    const r = run(["export"]);
    expect(r.body.stdout).toBeUndefined();
    expect(JSON.stringify(r).length).toBeLessThan(512 * 1024);
    expect(out(r.body).tasks.length).toBeGreaterThanOrEqual(8);
  });

  it("never makes a store that isn't there", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "ts-api-")), "store.db");
    const r = spawnSync(process.execPath, [cli, "api", "--json"], {
      input: JSON.stringify({ caller: art, path: "run", body: { argv: ["ready"] } }),
      env: { PATH: process.env.PATH ?? "", TASKSTORE_DB: missing, TASKSTORE_AGENTS: "art" }, encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(existsSync(missing)).toBe(false);
  });
});
