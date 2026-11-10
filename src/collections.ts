// The tasks role's shared collection (loom docs/specs/collections.md, "Declaring a provider"; t-2029): every task as
// a record, `tasks/task/<id>`, so loom's windows read one set wherever a task appears, and taskstore stays the
// authority. Pure, like project-feed.ts: the CLI reads the store and hands the tasks in, as `loom-tasks collections
// query --json` with loom's batch on stdin.
//
// Who sees what: the tasks piece's pages show every household owner the same tasks (it doesn't declare owners: 2),
// so a record's audience is household owners, and this provider answers no rows to anyone else (an agent's token loom
// let through its grants, an owner of some agents): it decides for its viewer before it pages, as the contract asks.
// It has no change log yet: loom takes snapshots and works out what changed itself (the bridge).
import type { Link, Task } from "./core.js";
import { stateOf } from "./thread-feed.js";

/** The record type, as package.json's loom.collections declares it (test/collections.test.ts holds the two equal). */
export const TASK_TYPE = {
  version: "1.2",
  schema: { type: "object", properties: { title: { type: "string" }, status: { type: "string" }, priority: { type: "number" } } },
  fields: {
    refState: { class: "household" },
    title: { class: "household", search: true },
    type: { class: "household", filter: ["eq", "in"] },
    status: { class: "household", filter: ["eq", "in"], order: true },
    priority: { class: "household", filter: ["eq", "in", "lte", "gte"], order: true },
    assignee: { class: "household", filter: ["eq", "in", "has"] },
    created: { class: "household", filter: ["lt", "lte", "gt", "gte"], order: true },
    updated: { class: "household", filter: ["lt", "lte", "gt", "gte"], order: true },
    closed: { class: "household", filter: ["has", "gte"], order: true },
    closeReason: { class: "household", filter: ["eq"] },
    blocked: { class: "household", filter: ["eq"] },
    blockers: { class: "household" },
    ready: { class: "household", filter: ["eq"] },
    parent: { class: "household", filter: ["eq", "has"] },
    source: { class: "household", filter: ["eq", "prefix", "has"] },
    goal: { class: "household" },
    why: { class: "household" },
    doneWhen: { class: "household" },
    ask: { class: "household", filter: ["has"] },
    comments: { class: "household" },
    description: { class: "household", heavy: true, search: true },
  },
  default_fields: ["title", "type", "status", "priority", "assignee", "updated"],
  max_page: 500,
  aggregates: { count: { by: ["status"] } },
} as const;

type Scalar = string | number | boolean | null;
type Clause = [string, string, Scalar | Scalar[]] | [string, "has"];
type Order = [string, "asc" | "desc"];
export interface ProviderQuery { id: string; type: string; version: number; where: Clause[]; order: Order[]; limit: number; after: unknown[] | null; fields: string[] }
export interface Batch { viewer?: { kind?: string; household?: boolean }; now?: string; queries?: ProviderQuery[] }
export type TaskRecord = Record<string, unknown> & { id: string };

/** Whether this viewer is one the tasks' pages show: loom itself, or a household owner. */
export const seesTasks = (viewer: Batch["viewer"]): boolean => viewer?.kind === "core" || (viewer?.kind === "member" && viewer.household === true);

/** What a record says of the store's links (the ready and blocked queues): each task's open blockers, by id, in the
 * order they were linked. A blocker that's gone from the store or closed blocks nothing (core.ts blockedIds). */
export function blockersOf(tasks: readonly Task[], links: readonly Link[]): Map<string, string[]> {
  const open = new Set(tasks.filter((t) => t.status !== "closed").map((t) => t.id));
  const out = new Map<string, string[]>();
  for (const l of links) if (l.type === "blocks" && open.has(l.dependsOn)) out.set(l.id, [...(out.get(l.id) ?? []), l.dependsOn]);
  return out;
}

/** A task as its record: the store's own fields, its parent, and `updated`, its newest activity (made, started, closed,
 * or its newest comment). `blocked` is whether any blocker is still open (`blockers`, which), and `ready` whether it's
 * in the ready queue (`taskstore ready`: open, not an epic, not blocked), so the queues are a filter, not a join.
 * `updated` isn't every change: an update (a title, an assignee, an ask) doesn't move it, and a
 * reopen can move it back, since the store keeps no time for those; loom's bridge still sees them, comparing whole
 * records. A change log (t-2029) would give a true one. Its comments are counted, never sent. */
export function recordOf(t: Task, parentOf: ReadonlyMap<string, string>, blockers: ReadonlyMap<string, string[]> = new Map(), owner = ""): TaskRecord {
  const on = blockers.get(t.id) ?? [];
  const times = [t.createdAt, t.startedAt, t.closedAt, ...t.comments.map((c) => c.at)].filter((x): x is string => typeof x === "string");
  const updated = times.reduce((a, b) => (b > a ? b : a), t.createdAt);
  // A shared row cannot say "you": the owner and other-reader variants come from the SAME formatter as refs.
  // A non-owner sentinel chooses the named wording even when owner is empty; no viewer's identity is cached.
  const view = { tasks: [], links: [], owner, viewer: "" };
  const other = stateOf(t, { ...view, viewer: "\u0000" }, on.length > 0);
  const own = stateOf(t, { ...view, viewer: owner }, on.length > 0);
  const refState = { status: other.status, tone: other.tone ?? null, owner: owner || null, ownerStatus: own.status };
  const r: TaskRecord = {
    refState,
    id: t.id, title: t.title, type: t.type, status: t.status, priority: t.priority, created: t.createdAt, updated,
    closed: t.closedAt ?? null, closeReason: t.status === "closed" ? (t.closeReason ?? null) : null,
    blocked: on.length > 0, blockers: on, ready: t.status === "open" && t.type !== "epic" && on.length === 0,
    assignee: t.assignee ?? null, parent: parentOf.get(t.id) ?? null, source: t.source ?? null,
    goal: t.goal ?? null, why: t.why ?? null, doneWhen: t.doneWhen ?? null, ask: t.ask ?? null, comments: t.comments.length,
    description: t.description ?? null, audience: { owners: true },
  };
  return r;
}

const rank = (v: unknown): number => (v === undefined || v === null ? 0 : typeof v === "boolean" ? 1 : typeof v === "number" ? 2 : 3);
function compare(a: unknown, b: unknown): number {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (typeof a === "string") return a < (b as string) ? -1 : a > (b as string) ? 1 : 0;
  return (a as number) - (b as number);
}
/** loom's own matching (src/collections/memory.ts): a value of another kind never matches a comparison. */
function matches(r: TaskRecord, where: readonly Clause[]): boolean {
  return where.every((c) => {
    const v = Object.hasOwn(r, c[0]) ? r[c[0]] : undefined;
    switch (c[1]) {
      case "has": return v !== undefined && v !== null;
      case "eq": return compare(v, c[2]) === 0 && rank(v) === rank(c[2]);
      case "in": return (c[2] as Scalar[]).some((x) => compare(v, x) === 0 && rank(v) === rank(x));
      case "prefix": return typeof v === "string" && v.startsWith(c[2] as string);
      case "lt": return rank(v) === rank(c[2]) && compare(v, c[2]) < 0;
      case "lte": return rank(v) === rank(c[2]) && compare(v, c[2]) <= 0;
      case "gt": return rank(v) === rank(c[2]) && compare(v, c[2]) > 0;
      case "gte": return rank(v) === rank(c[2]) && compare(v, c[2]) >= 0;
      default: return false;
    }
  });
}
const keyOf = (r: TaskRecord, order: readonly Order[]): unknown[] => [...order.map(([f]) => r[f] ?? null), r.id];
function cmpKeys(a: unknown[], b: unknown[], order: readonly Order[]): number {
  for (let i = 0; i < a.length; i++) {
    const c = compare(a[i], b[i]);
    if (c) return i < order.length && order[i][1] === "desc" ? -c : c;
  }
  return 0;
}

/**
 * The answer to loom's batch, as the lines it reads (collections.md: `{"id", "row"}` per row, then `{"id", "more"}`,
 * or `{"id", "error"}`). Each query is loom's, already checked against the declaration: only declared operators on
 * declared fields, its limit within max_page, its fields the ones to send. Rows are filtered for the viewer before
 * they're paged, and carry only the fields asked for, the order's, and their audience.
 */
export function answer(batch: Batch, tasks: readonly Task[], links: readonly Link[], owner = ""): string[] {
  const parentOf = new Map(links.filter((l) => l.type === "parent-child").map((l) => [l.id, l.dependsOn]));
  const blockers = blockersOf(tasks, links);
  const mine = seesTasks(batch.viewer) ? tasks.map((t) => recordOf(t, parentOf, blockers, owner)) : [];
  const out: string[] = [];
  for (const q of batch.queries ?? []) {
    if (q.type !== "task") { out.push(JSON.stringify({ id: q.id, error: "unsupported-version" })); continue; }
    if (q.version !== 1) { out.push(JSON.stringify({ id: q.id, error: "unsupported-version" })); continue; }
    const live = mine.filter((r) => matches(r, q.where)).sort((a, b) => cmpKeys(keyOf(a, q.order), keyOf(b, q.order), q.order));
    let from = 0;
    if (q.after !== null) {
      if (!Array.isArray(q.after) || q.after.length !== q.order.length + 1) { out.push(JSON.stringify({ id: q.id, error: "bad-query" })); continue; }
      from = live.findIndex((r) => cmpKeys(keyOf(r, q.order), q.after!, q.order) > 0);
      if (from < 0) from = live.length;
    }
    const page = live.slice(from, from + q.limit);
    const send = new Set(["id", "audience", ...q.fields, ...q.order.map(([f]) => f)]);
    for (const r of page) out.push(JSON.stringify({ id: q.id, row: Object.fromEntries(Object.entries(r).filter(([k]) => send.has(k))) }));
    // More only beside a full page, as asked.
    out.push(JSON.stringify({ id: q.id, more: page.length === q.limit && from + q.limit < live.length }));
  }
  return out;
}
