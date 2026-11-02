// taskstore's project section feed for loom's project hub (loom
// docs/specs/projects.md, "Section feeds (the seam)" and "The tasks piece's
// side"):
//
//   loom-tasks project-feed --json --project <slug> --since <iso>
//              [--epic <id>] [--name <alias>]... [--venue <v>]...
//
// The project's tree is the --epic task's descendants over parent-child
// links. Its tasks go in four groups: waiting on the owner (open or in
// progress, assigned to TASKSTORE_OWNER), ready (the core's ready queue),
// blocked, and done since --since. Open tasks outside the tree whose title or
// description names the project (the slug or any --name) join the first three
// groups too, with status "outside the tree". An item's body is the task's
// description, and it always keeps any conversation digest id (`dg-…`) the
// description cites, so the tasks and conversations sections cross-reference
// by text. --venue is accepted and unused: a task has no venue.
//
// Pure, like loom-ui.ts: the CLI reads the store (export + ready) into a
// FeedView and prints feed()'s answer. The output keeps loom's caps: at most
// 8 groups and 50 items in all, each string within its limit.

import type { Link, Task } from "./core.js";
import type { ReadyEntry } from "./loom-ui.js";

export interface FeedView {
  tasks: Task[];
  links: Link[];
  /** The core's `ready` window, in its priority order. */
  ready: ReadyEntry[];
  /** TASKSTORE_OWNER; empty, nothing is waiting on anyone. */
  owner: string;
}

export interface FeedArgs {
  project: string;
  /** ISO-8601; done tasks closed at or after it. */
  since: string;
  epic?: string;
  names: string[];
  venues: string[];
}

export interface FeedItem { title: string; when?: string; status?: string; ref?: string; body?: string }
export interface FeedGroup { title: string; items: FeedItem[] }
export interface Feed { groups: FeedGroup[] }

export const MAX_ITEMS = 50;
const TITLE_MAX = 200;
const GROUP_TITLE_MAX = 80;
const STATUS_MAX = 24;
const REF_MAX = 200;
const BODY_MAX = 600;
export const OUTSIDE = "outside the tree";
/** A conversation digest's id: "dg-" + 12 hex (loom docs/specs/conversations.md, "Digests"). */
const DIGEST = /\bdg-[0-9a-f]{12}\b/g;

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** loom's `when`: ISO-8601 UTC. Undefined for a time that doesn't parse. */
function utc(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** The epic's descendants over parent-child links (the epic itself is not one). */
export function treeOf(links: Link[], epic: string | undefined): Set<string> {
  const tree = new Set<string>();
  if (!epic) return tree;
  const children = new Map<string, string[]>();
  for (const l of links) {
    if (l.type !== "parent-child") continue;
    (children.get(l.dependsOn) ?? children.set(l.dependsOn, []).get(l.dependsOn)!).push(l.id);
  }
  const stack = [...(children.get(epic) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === epic || tree.has(id)) continue;
    tree.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return tree;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether text names the project: any of its names as a whole word, any case.
 * A name is a slug (letters, digits, dashes), so a dash or a letter either
 * side means another word: "pond" is not in "ponder" or "on-pond".
 */
export function namesProject(text: string, names: readonly string[]): boolean {
  return names.some((n) => n && new RegExp(`(^|[^a-z0-9-])${escape(n.toLowerCase())}($|[^a-z0-9-])`).test(text.toLowerCase()));
}

/** The description, clipped to the cap, always keeping the digest ids it cites. */
export function bodyOf(description: string | undefined): string | undefined {
  const d = description?.trim();
  if (!d) return undefined;
  if (d.length <= BODY_MAX) return d;
  const digests = [...new Set(d.match(DIGEST) ?? [])];
  const kept = clip(d, BODY_MAX);
  const missing = digests.filter((id) => !kept.slice(0, -1).includes(id));
  if (!missing.length) return kept;
  const tail = `\n${missing.join(" ")}`.slice(0, BODY_MAX - 1);
  return clip(d, BODY_MAX - tail.length) + tail;
}

const statusWord = (t: Task) =>
  t.status === "in_progress" ? "in progress" : t.status === "closed" ? (t.closeReason === "cancelled" ? "cancelled" : "done") : t.status;

/** When it last moved: the newest of created, started and its comments. */
function lastMoved(t: Task): string | undefined {
  const times = [t.createdAt, t.startedAt, ...t.comments.map((c) => c.at)].map(utc).filter((x): x is string => !!x);
  return times.length ? times.reduce((a, b) => (b > a ? b : a)) : undefined;
}

function item(t: Task, status: string, when: string | undefined): FeedItem {
  const it: FeedItem = { title: clip(t.title.trim() || t.id, TITLE_MAX) };
  if (when) it.when = when;
  it.status = clip(status, STATUS_MAX);
  if (t.id && t.id.length <= REF_MAX) it.ref = t.id;
  const body = bodyOf(t.description);
  if (body) it.body = body;
  return it;
}

/**
 * Keep the groups to MAX_ITEMS in all, sharing them out fairly: every group
 * gets its share, and a group that needs less leaves the rest to the others.
 * A group that is cut says so in its title.
 */
function capGroups(groups: Array<{ title: string; items: FeedItem[] }>): FeedGroup[] {
  const sizes = groups.map((g) => g.items.length);
  const take = sizes.map(() => 0);
  let left = MAX_ITEMS;
  while (left > 0) {
    const open = sizes.map((n, i) => (take[i] < n ? i : -1)).filter((i) => i >= 0);
    if (!open.length) break;
    for (const i of open) {
      if (left === 0) break;
      take[i]++;
      left--;
    }
  }
  return groups.map((g, i) => ({
    title: clip(take[i] < sizes[i] ? `${g.title} (${take[i]} of ${sizes[i]})` : g.title, GROUP_TITLE_MAX),
    items: g.items.slice(0, take[i]),
  }));
}

/** The feed for one project: the four groups that have anything in them, in order. */
export function feed(v: FeedView, a: FeedArgs): Feed {
  const tree = treeOf(v.links, a.epic);
  const names = [a.project, ...a.names];
  const blockers = new Map<string, string[]>();
  for (const l of v.links) {
    if (l.type !== "blocks") continue;
    const b = v.tasks.find((t) => t.id === l.dependsOn);
    if (b && b.status !== "closed") (blockers.get(l.id) ?? blockers.set(l.id, []).get(l.id)!).push(b.id);
  }
  const order = new Map(v.tasks.map((t, i) => [t.id, i]));
  const byPriority = (x: Task, y: Task) => x.priority - y.priority || order.get(x.id)! - order.get(y.id)!;

  // Open tasks in the tree, then open tasks outside it that name the project.
  const live = v.tasks.filter((t) => t.status !== "closed" && t.id !== a.epic);
  const inTree = live.filter((t) => tree.has(t.id));
  const outside = live.filter((t) => !tree.has(t.id) && namesProject(`${t.title}\n${t.description ?? ""}`, names));
  const isOutside = new Set(outside.map((t) => t.id));
  const candidates = [...inTree, ...outside];
  const status = (t: Task, s: string) => (isOutside.has(t.id) ? OUTSIDE : s);

  const waiting = v.owner ? candidates.filter((t) => t.assignee === v.owner).sort(byPriority) : [];
  const taken = new Set(waiting.map((t) => t.id));
  const readyIds = new Set(v.ready.map((e) => e.id));
  const ready = candidates.filter((t) => !taken.has(t.id) && readyIds.has(t.id)).sort(byPriority);
  const blocked = candidates.filter((t) => !taken.has(t.id) && blockers.has(t.id)).sort(byPriority);
  const sinceMs = Date.parse(a.since);
  const done = v.tasks
    .filter((t) => tree.has(t.id) && t.status === "closed" && Date.parse(t.closedAt ?? "") >= sinceMs)
    .sort((x, y) => Date.parse(y.closedAt!) - Date.parse(x.closedAt!) || order.get(x.id)! - order.get(y.id)!);

  const groups = [
    { title: "Waiting on you", items: waiting.map((t) => item(t, status(t, statusWord(t)), lastMoved(t))) },
    { title: "Ready", items: ready.map((t) => item(t, status(t, "ready"), lastMoved(t))) },
    { title: "Blocked", items: blocked.map((t) => item(t, status(t, `blocked by ${blockers.get(t.id)!.join(", ")}`), lastMoved(t))) },
    { title: "Done", items: done.map((t) => item(t, statusWord(t), utc(t.closedAt))) },
  ].filter((g) => g.items.length);
  return { groups: capGroups(groups) };
}

/**
 * The CLI's arguments after `project-feed`: a FeedArgs, or a string saying
 * what's wrong (a usage error). Flags repeat for --name and --venue.
 */
export function parseFeedArgs(argv: readonly string[]): FeedArgs | string {
  const out: FeedArgs = { project: "", since: "", names: [], venues: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") continue;
    const value = argv[i + 1];
    if (!["--project", "--since", "--epic", "--name", "--venue"].includes(flag)) return `unknown argument ${JSON.stringify(flag)}`;
    if (value === undefined || value.startsWith("--")) return `${flag} needs a value`;
    i++;
    if (flag === "--project") out.project = value;
    else if (flag === "--since") out.since = value;
    else if (flag === "--epic") out.epic = value;
    else if (flag === "--name") out.names.push(value);
    else out.venues.push(value);
  }
  if (!out.project) return "--project is required";
  if (!out.since) return "--since is required";
  if (Number.isNaN(Date.parse(out.since))) return `--since is an ISO-8601 time, not ${JSON.stringify(out.since)}`;
  return out;
}
