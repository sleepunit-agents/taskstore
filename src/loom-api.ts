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
//   - an agent named in TASKSTORE_AGENTS (comma-separated), as that agent:
//     the actor comes from loom's resolved caller, never from the request;
//   - nobody else. A piece's credential (a box) gets nothing here.
// And what it leaves out: `import` (it reads a file path on loom's machine)
// and the loom-facing verbs (api, ui).
//
// An answer is held to loom's 512KB per answer, so stdout over 256KB comes
// back gzipped and base64'd as stdoutGz (`list` on a real store is ~350KB).

import { gzipSync } from "node:zlib";

export interface ApiRequest {
  caller?: { kind?: string; agent?: string; subject?: string };
  path?: string;
  body?: { argv?: unknown };
}

export interface Ran {
  exit: number;
  stdout: string;
  stderr: string;
}

export type RunCli = (argv: string[], actor: string) => Ran;

export interface ApiAnswer {
  status: number;
  body: Record<string, unknown>;
}

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
    const allowed = (env.TASKSTORE_AGENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (allowed.includes(caller.agent)) return caller.agent;
    return refuse(403, `${caller.agent} doesn't use this store`);
  }
  return refuse(403, "only the owner and this store's agents use the tasks piece");
}

export function answer(request: ApiRequest | null, env: NodeJS.ProcessEnv, runCli: RunCli): ApiAnswer {
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
  const r = runCli(argv as string[], actor);
  const body: Record<string, unknown> = { exit: r.exit, stderr: r.stderr.slice(0, 16 * 1024) };
  if (Buffer.byteLength(r.stdout) > PLAIN_STDOUT) body.stdoutGz = gzipSync(r.stdout).toString("base64");
  else body.stdout = r.stdout;
  return { status: 200, body };
}
