// taskstore's thread section feed for a loom Comms thread (loom
// docs/specs/comms.md, "Work in this thread", "The thread feed"):
//
//   loom-tasks thread-feed --json --conversation <cv-…> [--ref <ref>]...
//
// It answers the tasks the thread names (each `t-N` ref the store holds) and
// the tasks made in it (source `conversation:<cv>`, `made: true`), each with
// its state in words. Refs that aren't tasks (a change, a note) are another
// piece's and are skipped. Pure, like project-feed.ts: the CLI reads the
// store into a FeedView and prints threadFeed()'s answer.

import type { Task } from "./core.js";
import type { FeedView } from "./project-feed.js";

export interface ThreadItem {
  title: string; ref: string; status: string; tone?: "bad" | "warn" | "ok"; when?: string; page?: string; made?: true;
}
export interface ThreadArgs { conversation: string; refs: string[] }
/** The tasks, links and owner a thread feed reads (no ready queue), and who's looking (loom's caller.who). */
export interface ThreadView { tasks: Task[]; links: FeedView["links"]; owner: string; viewer?: string }

export const MAX_ITEMS = 50;
const CV = /^cv-[0-9a-f]{12}$/;
const TASK_REF = /^t-[0-9]{1,9}$/;
const PAGE = /^[a-z0-9._~/-]{0,200}$/;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const utc = (iso: string | undefined) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
};

/** The task's state, in words, and its tone: blocked is a problem, the owner's open ask waits on them, done is done. */
export function stateOf(t: Task, v: ThreadView, blocked: boolean): { status: string; tone?: ThreadItem["tone"] } {
  if (t.status === "closed") return t.closeReason === "cancelled" ? { status: "Cancelled" } : { status: "Done", tone: "ok" };
  if (blocked) return { status: "Blocked", tone: "bad" };
  // The owner's call (the tasks page's "Your call"): "you" only to the owner; anyone else reads whose it is.
  if (v.owner && t.assignee === v.owner) {
    const mine = !v.viewer || v.viewer === v.owner;
    return { status: clip(mine ? "Waiting on you" : `Waiting on ${v.owner[0].toUpperCase()}${v.owner.slice(1)}`, 24), tone: "warn" };
  }
  return { status: t.status === "in_progress" ? "In progress" : "Open" };
}

export function threadFeed(v: ThreadView, a: ThreadArgs): { items: ThreadItem[] } {
  const source = `conversation:${a.conversation}`;
  const byId = new Map(v.tasks.map((t) => [t.id, t]));
  const blocked = new Set<string>();
  for (const l of v.links) if (l.type === "blocks" && byId.get(l.dependsOn)?.status !== "closed" && byId.has(l.dependsOn)) blocked.add(l.id);
  const item = (t: Task, made: boolean): ThreadItem => {
    const p = `task/${t.id}`;
    const when = utc(t.closedAt) ?? utc(t.startedAt) ?? utc(t.createdAt);
    return {
      title: clip(t.title.trim() || t.id, 200), ref: t.id, ...stateOf(t, v, blocked.has(t.id)),
      ...(when ? { when } : {}), ...(PAGE.test(p) && !p.includes("..") ? { page: p } : {}), ...(made ? { made: true as const } : {}),
    };
  };
  const out = new Map<string, ThreadItem>();
  // Made here first, newest first, so the cap keeps what the thread caused.
  // A ref is at most 200 characters in loom's answer: an imported task with a longer id is left out, not the section.
  const made = v.tasks.filter((t) => t.source === source && t.id.length <= 200).reverse();
  for (const t of made) out.set(t.id, item(t, true));
  for (const r of a.refs) {
    const t = TASK_REF.test(r) ? byId.get(r) : undefined;
    if (t && !out.has(t.id)) out.set(t.id, item(t, false));
  }
  return { items: [...out.values()].slice(0, MAX_ITEMS) };
}

/** The CLI's arguments after `thread-feed`: ThreadArgs, or what's wrong. */
export function parseThreadArgs(argv: readonly string[]): ThreadArgs | string {
  const out: ThreadArgs = { conversation: "", refs: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") continue;
    const value = argv[i + 1];
    if (flag !== "--conversation" && flag !== "--ref") return `unknown argument ${JSON.stringify(flag)}`;
    if (value === undefined || value.startsWith("--")) return `${flag} needs a value`;
    i++;
    if (flag === "--conversation") out.conversation = value;
    else if (out.refs.length < 200) out.refs.push(value);
    else return "at most 200 --ref";
  }
  if (!CV.test(out.conversation)) return "--conversation is a conversation id (cv- and 12 hex digits)";
  return out;
}
