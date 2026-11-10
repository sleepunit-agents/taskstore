// taskstore as loom's tasks piece, over loom's piece API (loom
// docs/extensions.md, "The API"): `POST /api/tasks/run` reaches
// `taskstore api --json` with {caller, path, body} on stdin, and the answer is
// {status?, body}. That's how a body that isn't on loom's machine (a house,
// a box elsewhere) uses the one store instead of an empty one of its own.
//
//   path "run", body {argv: ["ready"]}  ->  {exit, stdout, stderr}
//
// It runs the CLI itself on that argv, so a remote command means exactly what
// it means locally: the same verbs, flags, JSON and exit codes (0/1/2/3).
// What it adds is who:
//   - the owner, as TASKSTORE_OWNER (or "owner");
//   - an agent loom's grants authority allowed (the caller carries
//     `granted: true`, loom agent-runtime.md "Agent grants"), as that agent:
//     with a runtime installed the grant decides, not this store's list;
//   - otherwise an agent named in TASKSTORE_AGENTS (comma-separated), the
//     fallback for a household without a runtime. Either way the actor comes
//     from loom's resolved caller, never from the request;
//   - nobody else. A piece's credential (a box) gets nothing here.
// And what it leaves out: `import` (it reads a file path on loom's machine)
// and the loom-facing verbs (api, ui).
//
// And where a task says it came from (it-ts-source): `--source conversation:<cv>`
// lists it as made in that Comms thread, so an agent's body names only its own
// conversation (t-2117). A house's piece-call appends the runtime's signed
// statement (`--principal <statement>`, taken off here before the CLI runs);
// the source is kept only when that statement verifies (`loom runtime
// principal --verify`), is this same agent's, and is for that conversation.
// Otherwise the flag is taken out, the rest of the command runs, and stderr
// says why. The owner's own calls say it themselves.
//
// A call that wrote (a verb that changes the store, and it succeeded) answers
// `changed: true` beside its status, so loom pulls the tasks' shared collection
// at once instead of on its next 15 s pull (loom docs/extensions.md, "The API").
//
// An answer is held to loom's 512KB per answer, so stdout over 256KB comes
// back gzipped and base64'd as stdoutGz (`list` on a real store is ~350KB).

import { gzipSync } from "node:zlib";

export interface ApiRequest {
  caller?: { kind?: string; agent?: string; subject?: string; granted?: unknown };
  path?: string;
  body?: { argv?: unknown };
}

export interface Ran {
  exit: number;
  stdout: string;
  stderr: string;
}

export type RunCli = (argv: string[], actor: string) => Ran;

/** The runtime's word on a statement (`loom runtime principal --verify`), or null when it doesn't verify. */
export interface Verified { agent?: unknown; conversation?: unknown }
export type VerifyStatement = (statement: string) => Verified | null;

/**
 * argv without the `--principal <statement>` a house's piece-call appends, and that statement ("" when none). Only a
 * trailing pair is the wrapper's; with more than one, the last. One in the middle is the body's own words, and the
 * CLI refuses it as an unknown flag.
 */
export function takePrincipal(argv: string[]): { argv: string[]; statement: string } {
  let rest = argv.slice(), statement = "", found = false;
  while (rest.length >= 2 && rest[rest.length - 2] === "--principal") {
    if (!found) statement = rest[rest.length - 1];
    found = true;
    rest = rest.slice(0, -2);
  }
  return { argv: rest, statement };
}

/** Each place `--source` is given, as the CLI parses flags (every `--x` takes the next word; the last one wins). */
function sourceFlags(argv: string[]): number[] {
  const at: number[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    if (argv[i] === "--source") at.push(i);
    i++;
  }
  return at;
}

const CONVERSATION_SOURCE = /^conversation:(.*)$/s;

/**
 * argv with any conversation source this agent's statement doesn't prove taken out, and why (t-2117). null when the
 * argv stands as it is.
 */
export function provenSource(argv: string[], agent: string, statement: string, verify: VerifyStatement): { argv: string[]; why: string } | null {
  const at = sourceFlags(argv);
  const claimed = at.map((i) => CONVERSATION_SOURCE.exec(argv[i + 1] ?? "")?.[1]).filter((x): x is string => x !== undefined);
  if (!claimed.length) return null;
  let v: Verified | null = null;
  if (statement) {
    try { v = verify(statement); } catch { v = null; }
  }
  const own = v && v.agent === agent && typeof v.conversation === "string" && /^cv-[0-9a-f]{12}$/.test(v.conversation) ? v.conversation : null;
  if (own && claimed.every((c) => c === own)) return null;
  const drop = new Set(at.filter((i) => CONVERSATION_SOURCE.test(argv[i + 1] ?? "")).flatMap((i) => [i, i + 1]));
  return {
    argv: argv.filter((_, i) => !drop.has(i)),
    why: own
      ? `taskstore: --source named a conversation this body isn't in (it's in ${own}); written without it\n`
      : "taskstore: --source conversation: needs the runtime's word that this body is in it (none came, or it didn't verify); written without it\n",
  };
}

export interface ApiAnswer {
  status: number;
  body: Record<string, unknown>;
  changed?: true;
}

/** The verbs that change the store (cli.ts): a run of one that succeeded may have moved a task's record. */
export const WRITES: ReadonlySet<string> = new Set(["create", "claim", "unclaim", "close", "reopen", "delete", "update", "comment", "link", "unlink"]);

const REFUSED = new Set(["import", "api", "ui"]);
const MAX_ARGS = 32;
const MAX_ARG = 64 * 1024;
const PLAIN_STDOUT = 256 * 1024;

function refuse(status: number, error: string): ApiAnswer {
  return { status, body: { error } };
}

/** Who this caller runs as, or why it can't. */
export function actorFor(caller: ApiRequest["caller"], env: NodeJS.ProcessEnv): string | ApiAnswer {
  if (caller?.kind === "owner") return env.TASKSTORE_OWNER?.trim() || "owner";
  if (caller?.kind === "agent" && typeof caller.agent === "string") {
    // loom's grants authority already decided this call (loom sets granted only after its yes).
    if (caller.granted === true) return caller.agent;
    const allowed = (env.TASKSTORE_AGENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (allowed.includes(caller.agent)) return caller.agent;
    return refuse(403, `${caller.agent} doesn't use this store`);
  }
  return refuse(403, "only the owner and this store's agents use the tasks piece");
}

export function answer(request: ApiRequest | null, env: NodeJS.ProcessEnv, runCli: RunCli, verify: VerifyStatement = () => null): ApiAnswer {
  if (!request || typeof request !== "object") return refuse(400, "not a piece API request");
  const actor = actorFor(request.caller, env);
  if (typeof actor !== "string") return actor;
  if (request.path !== "run") return refuse(404, `no ${String(request.path)} here; the one call is run`);
  const argv = request.body?.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGS) {
    return refuse(400, `argv is a list of 1 to ${MAX_ARGS} strings`);
  }
  if (!argv.every((a) => typeof a === "string" && a.length <= MAX_ARG && !a.includes("\0"))) {
    return refuse(400, "argv is a list of plain strings");
  }
  if (REFUSED.has(argv[0])) return refuse(403, `${argv[0]} runs only on loom's machine`);
  let { argv: args, statement } = takePrincipal(argv as string[]);
  let note = "";
  if (request.caller?.kind !== "owner") {
    const fixed = provenSource(args, String(request.caller?.agent ?? ""), statement, verify);
    if (fixed) ({ argv: args, why: note } = fixed);
  }
  if (!args.length) return refuse(400, `argv is a list of 1 to ${MAX_ARGS} strings`);
  const r = runCli(args, actor);
  const body: Record<string, unknown> = { exit: r.exit, stderr: (note + r.stderr).slice(0, 16 * 1024) };
  if (Buffer.byteLength(r.stdout) > PLAIN_STDOUT) body.stdoutGz = gzipSync(r.stdout).toString("base64");
  else body.stdout = r.stdout;
  // A write that failed outright changed nothing; exit 3 is unlink's "no such edge", which changed nothing either.
  return { status: 200, body, ...(r.exit === 0 && WRITES.has(args[0]) ? { changed: true as const } : {}) };
}
