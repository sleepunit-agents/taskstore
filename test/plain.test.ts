// The plain-words lint (src/plain.ts) and the CLI's policy over it: the owner's
// task is refused until it reads plainly and asks something; any other task is
// written, with warnings.
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint, lintField } from "../src/plain.js";

const texts = (fs: ReturnType<typeof lint>) => fs.map((f) => f.text);

describe("lint", () => {
  it("finds what t-1273's first title couldn't say plainly: a leading tag and a site code", () => {
    expect(lintField("title", "pond: get the dead S13 MiFi onto a bench, or drop this").map((f) => [f.what, f.text]))
      .toEqual([["a leading tag", "pond:"], ["a raw site or unit code", "S13"]]);
  });

  it("finds the alert loom#474 refused: an approval id, a round, a wake word, a task id", () => {
    expect(texts(lint({ ask: "Allow local-wake card a-7693c00e on loom's Home so Art can set up the backup for t-40 (round 9)" })))
      .toEqual(["t-40", "a-7693c00e", "round 9", "local-wake"]);
  });

  it("finds hex ids, house ids, pull requests and lane jargon, but not the word lane", () => {
    expect(texts(lint({ title: "restore ef2a7a's agent after h-52 died; see art#69 and the plan-night lane" })))
      .toEqual(["art#69", "h-52", "ef2a7a", "plan-night"]);
    expect(lint({ title: "Make pitch a lane that bass, chords and lead sample at their own rates" })).toEqual([]);
  });

  it("lets the lines read in context name a task or a pull request (loom links them), but not internal ids", () => {
    expect(lint({ ifNo: "I close this and fold it into t-1352.", why: "Waits on sleepunit-agents/loom#479." })).toEqual([]);
    expect(texts(lint({ ifYes: "I re-arm round 3" }))).toEqual(["round 3"]);
  });

  it("passes plain words, product names and numbers that aren't codes", () => {
    for (const s of [
      "Find out why the field Pis drop off the network, using the failed Station 13 hotspot",
      "Can you get the old Station 13 hotspot and a spare Pi onto a bench I can reach?",
      "Move loom's backups to Google Drive by Nov 10, 2026", "Upgrade Node to 24 on the GPU box",
    ]) expect(lint({ title: s, goal: s, ask: s })).toEqual([]);
  });

  it("holds each field to its length, and to one line", () => {
    expect(texts(lint({ ask: "x".repeat(141) }))).toEqual(["141 characters"]);
    expect(lint({ ask: "x".repeat(140) })).toEqual([]);
    expect(texts(lint({ goal: "one\ntwo" }))).toEqual(["a line break"]);
  });

  it("doesn't read a blank value (an update clearing a field)", () => {
    expect(lint({ title: "", ask: "  " })).toEqual([]);
  });
});

describe("the CLI's plain-words policy", () => {
  const repo = join(__dirname, "..");
  const cli = join(repo, "dist", "cli.js");
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TASKSTORE_")));
  let db = "";
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...baseEnv, TASKSTORE_DB: db } });
    return { code: r.status, body: JSON.parse(r.stdout || "null"), stderr: r.stderr };
  };
  beforeAll(() => {
    spawnSync("npm", ["run", "build"], { cwd: repo, stdio: "pipe" });
    db = join(mkdtempSync(join(tmpdir(), "taskstore-plain-")), "store.db");
  }, 60000);

  it("writes an agent's task that doesn't read plainly, and says why in warnings and on stderr", () => {
    const r = run("create", "pond: get the dead S13 MiFi onto a bench");
    expect(r.code).toBe(0);
    expect(r.body).toMatchObject({ ok: true, created: true, id: "t-1" });
    expect(r.body.warnings.slice(0, 3)).toEqual([
      "--title can't have \"pond:\" (a leading tag): it will read as jargon on the task list",
      "--title can't have \"S13\" (a raw site or unit code): it will read as jargon on the task list",
      "needs a plain summary: give it a --goal (what's true when it's done) and a --why",
    ]);
    expect(r.body.warnings[3]).toMatch(/^the plain form, like:\ntaskstore update <id>/);
    expect(r.stderr).toContain("taskstore: warning: needs a plain summary");
  });

  it("has no warnings for a plain title with a goal", () => {
    const r = run("create", "Back up the photos offsite", "--goal", "Every photo has a copy off this machine.", "--why", "One disk would lose them all.");
    expect(r.code).toBe(0);
    expect(r.body).toEqual({ created: true, errors: [], id: "t-2", ok: true });
  });

  it("refuses to make a task the owner's while it doesn't read plainly, or asks nothing, and writes nothing", () => {
    const before = readFileSync(db);
    const jargon = run("update", "t-1", "--assignee", "jonathan", "--ask", "Can you bench it?");
    expect(jargon.code).toBe(1);
    expect(jargon.body).toMatchObject({ ok: false, errors: ["E_NOT_PLAIN"], found: [
      "--title can't have \"pond:\" (a leading tag)", "--title can't have \"S13\" (a raw site or unit code)"] });
    expect(jargon.body.message).toContain("Say it again in words, like:\ntaskstore update <id> --assignee jonathan");
    const noAsk = run("update", "t-2", "--assignee", "jonathan");
    expect(noAsk.code).toBe(1);
    expect(noAsk.body.message).toMatch(/^This task is jonathan's: give it an --ask/);
    expect(readFileSync(db)).toEqual(before);
    expect(run("show", "t-2").body.task.assignee).toBeUndefined();
  });

  it("takes the owner's task once it's plain and asks, stamping who asked", () => {
    const r = run("update", "t-1", "--assignee", "jonathan", "--title", "Find out why the field Pis drop off the network",
      "--goal", "We know what makes a field Pi lose its connection.", "--ask", "Can you get the old Station 13 hotspot onto a bench?",
      "--if-yes", "I test it and report.", "--if-no", "I close this.");
    expect(r.code).toBe(0);
    expect(r.body).toEqual({ errors: [], ok: true });
    expect(run("show", "t-1").body.task).toMatchObject({ assignee: "jonathan", askedBy: "art", ifNo: "I close this." });
  });

  it("doesn't hold up a priority change on the owner's task, but lints what an update says", () => {
    expect(run("update", "t-1", "--priority", "1").code).toBe(0);
    expect(run("update", "t-1", "--ask", "OK for round 2?").code).toBe(1);
    expect(run("update", "t-1", "--ask", "").code).toBe(1); // the owner's task can't lose its ask
  });

  it("knows the plain flags on create and update, and nowhere else", () => {
    expect(spawnSync(process.execPath, [cli, "close", "t-2", "--goal", "x"], { encoding: "utf8", env: { ...baseEnv, TASKSTORE_DB: db } }).status).toBe(2);
    expect(run("update", "t-2", "--done-when", "A restore works.", "--answers", "words").code).toBe(1); // answers needs an ask: E_MISSING_FIELD
    expect(run("update", "t-2", "--done-when", "A restore works.").body).toEqual({ errors: [], ok: true });
  });

  it("follows TASKSTORE_OWNER for whose task it is", () => {
    const r = spawnSync(process.execPath, [cli, "update", "t-2", "--assignee", "gage"], { encoding: "utf8", env: { ...baseEnv, TASKSTORE_DB: db, TASKSTORE_OWNER: "gage" } });
    expect(r.status).toBe(1);
    expect(run("update", "t-2", "--assignee", "gage").code).toBe(0); // gage isn't the owner here
  });
});
