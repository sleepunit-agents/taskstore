// taskstore over loom's piece API (src/loom-api.ts): who may run a command,
// as whom, and what a remote command can't reach. Through the built CLI, as
// loom-http runs it: `taskstore api --json` with the request on stdin.

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
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
  return JSON.parse(r.stdout) as { status: number; body: Record<string, unknown>; changed?: true };
}
const art = { kind: "agent", agent: "art" };
const run = (argv: string[], caller: unknown = art, env?: Record<string, string>) => api({ caller, path: "run", body: { argv } }, env);
const out = (b: Record<string, unknown>) =>
  JSON.parse(typeof b.stdout === "string" ? b.stdout : gunzipSync(Buffer.from(String(b.stdoutGz), "base64")).toString());

beforeAll(() => {
  // The built CLI is what loom-http runs; build it, as cli-binding does.
  execFileSync("npm", ["run", "build"], { cwd: join(__dirname, ".."), stdio: "pipe" });
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

  it("says changed only beside a write that succeeded, so loom pulls the shared collection at once", () => {
    const made = run(["create", "moves the record"]);
    expect(made.changed).toBe(true);
    const id = out(made.body).id as string;
    expect(run(["comment", id, "a note"]).changed).toBe(true);
    // Reads, a write that was refused, and unlink's "no such edge" moved nothing.
    for (const argv of [["show", id], ["ready"], ["list"], ["update", "t-99999", "--title", "x"], ["unlink", id, "t-1", "--type", "blocks"]]) {
      expect(run(argv), argv.join(" ")).not.toHaveProperty("changed");
    }
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

  it("lets in an agent loom's grants authority allowed, without its own list (t-1971)", () => {
    // mark isn't in TASKSTORE_AGENTS ("art"), but the runtime granted him tasks.
    const mark = { kind: "agent", agent: "mark", house: "h-7", granted: true };
    const made = run(["create", "granted, not listed"], mark);
    expect(made.status).toBe(200);
    expect(made.body.exit).toBe(0);
    expect(out(run(["show", out(made.body).id as string]).body).task.createdBy).toBe("mark");
    // Even with an empty list: the grant decides when a runtime is installed.
    expect(run(["ready"], mark, { TASKSTORE_AGENTS: "" }).status).toBe(200);
    // Only a literal true counts; anything else falls back to the list.
    expect(run(["ready"], { ...mark, granted: "true" }).status).toBe(403);
    expect(run(["ready"], { ...mark, granted: false }).status).toBe(403);
    // It never lets in a caller that isn't an agent.
    expect(run(["ready"], { kind: "piece", subject: "box/thor", granted: true }).status).toBe(403);
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

describe("taskstore api: where a task came from (t-2117)", () => {
  // A stand-in runtime: `--verify` with "S:<agent>:<cv>" on stdin verifies as that agent's statement for that conversation.
  let rt: string;
  beforeAll(() => {
    rt = join(mkdtempSync(join(tmpdir(), "ts-rt-")), "rt");
    writeFileSync(rt, `#!/bin/sh
[ "$1" = "--verify" ] || exit 2
[ "$2" = "--house" ] && [ "$3" = "h-elsewhere" ] && { echo '{"ok":false}'; exit 1; }
[ -n "$TS_RT_RECORD" ] && echo "$*" >> "$TS_RT_RECORD"
s=$(cat)
case "$s" in S:*:cv-*) a=\${s#S:}; a=\${a%%:*}; c=\${s##*:}; printf '{"ok":true,"agent":"%s","conversation":"%s"}' "$a" "$c";; *) echo '{"ok":false}'; exit 1;; esac
`);
    chmodSync(rt, 0o755);
  });
  const env = () => ({ TASKSTORE_PRINCIPAL: rt });
  const source = (b: Record<string, unknown>) => out(run(["show", out(b).id as string]).body).task.source as string | undefined;
  const mine = "conversation:cv-0123456789ab";

  it("keeps a conversation source the body's statement is for, and takes the statement off", () => {
    const r = run(["create", "made here", "--source", mine, "--principal", "S:art:cv-0123456789ab"], art, env());
    expect(r.body.exit, String(r.body.stderr)).toBe(0);
    expect(source(r.body)).toBe(mine);
  });

  it("takes out one its statement isn't for, or with no statement, and still writes the task", () => {
    for (const [p, why] of [[["--principal", "S:art:cv-00000000000f"], "isn't in"], [[], "needs the runtime's word"],
      [["--principal", "junk"], "needs the runtime's word"], [["--principal", "S:eve:cv-0123456789ab"], "needs the runtime's word"]] as const) {
      const r = run(["create", "made elsewhere", "--source", mine, ...p], art, env());
      expect(r.body.exit, String(r.body.stderr)).toBe(0);
      expect(source(r.body)).toBeUndefined();
      expect(String(r.body.stderr)).toContain(why);
    }
  });

  it("checks every --source given, and an update's too", () => {
    const made = run(["create", "to move"], art, env());
    const id = out(made.body).id as string;
    const two = run(["create", "two", "--source", mine, "--source", "conversation:cv-00000000000f", "--principal", "S:art:cv-0123456789ab"], art, env());
    expect(source(two.body)).toBeUndefined();
    const up = run(["update", id, "--source", "conversation:cv-00000000000f", "--priority", "2", "--principal", "S:art:cv-0123456789ab"], art, env());
    expect(up.body.exit, String(up.body.stderr)).toBe(0);
    expect(out(run(["show", id]).body).task.source).toBeUndefined();
    // Other kinds of source aren't a thread's: as before.
    const gh = run(["create", "from an issue", "--source", "github:acme/app#3"], art, env());
    expect(source(gh.body)).toBe("github:acme/app#3");
  });

  it("tells the runtime the caller's house, and a statement shown to another house's body proves nothing (t-2137)", () => {
    const record = join(mkdtempSync(join(tmpdir(), "ts-rec-")), "argv");
    const e = { ...env(), TS_RT_RECORD: record };
    const said = () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n") : []);
    const r = run(["create", "made here", "--source", mine, "--principal", "S:art:cv-0123456789ab"], { ...art, house: "h-7" }, e);
    expect(source(r.body)).toBe(mine);
    expect(said().at(-1)).toBe("--verify --house h-7");
    run(["create", "no house", "--source", mine, "--principal", "S:art:cv-0123456789ab"], art, e);
    expect(said().at(-1)).toBe("--verify --house -");
    const away = run(["create", "from elsewhere", "--source", mine, "--principal", "S:art:cv-0123456789ab"], { ...art, house: "h-elsewhere" }, e);
    expect(away.body.exit, String(away.body.stderr)).toBe(0);
    expect(source(away.body)).toBeUndefined();
    // A house id that isn't one, or "-": never verified, never read as no house.
    const n = said().length;
    for (const house of ["h-7 --x", "-", "", 7]) {
      const bad = run(["create", "odd house", "--source", mine, "--principal", "S:art:cv-0123456789ab"], { ...art, house }, e);
      expect(source(bad.body)).toBeUndefined();
    }
    // A service's houseless token (a bridge on loom's machine) is no body's.
    const svc = run(["create", "from a bridge", "--source", mine, "--principal", "S:art:cv-0123456789ab"], { ...art, service: "slack" }, e);
    expect(source(svc.body)).toBeUndefined();
    expect(said().length).toBe(n);
  });

  it("a principal typed mid-command is the body's own words: the CLI refuses it", () => {
    const r = run(["create", "x", "--principal", "S:art:cv-0123456789ab", "--source", mine], art, env());
    expect(r.body.exit).toBe(2);
  });

  it("the owner names a conversation itself", () => {
    const r = run(["create", "the owner's", "--source", mine], { kind: "owner" }, env());
    expect(source(r.body)).toBe(mine);
  });
});
