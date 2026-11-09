// taskstore on loom's page (loom docs/extensions.md, "The page: how a piece
// shows up on loom's page", contract v2). Three answers, all data, never
// markup:
//
//   loom-tasks ui --json        manifest(): tab, Home tile, the owner's asks
//   loom-tasks ui page --json   page(): stdin {path, query} -> one page
//   loom-tasks ui act --json    checkAct(): stdin {action, path, fields} ->
//                               a validated comment, which the CLI then writes
//                               through the core's own comment op
//
// Everything here is pure: the CLI reads the store (export + ready, both
// reads) into a UiView and does the one write. Nothing in this file touches
// the store, so a page load never lands in the interaction log.

import { SEARCH_FIELDS, type Link, type Task } from "./core.js";

export interface ReadyEntry { id: string; priority: number; title: string; type?: string }

export interface UiView {
  tasks: Task[];
  links: Link[];
  /** The core's `ready` window, already in its priority order. */
  ready: ReadyEntry[];
  /** Whose call an ask is: tasks assigned to this name (TASKSTORE_OWNER). */
  /** Whose call an ask is (TASKSTORE_OWNER). Empty: nobody's, so no asks. */
  owner: string;
  now: Date;
  /** IANA zone for dates (TZ); undefined = the system default. */
  timeZone?: string;
  /**
   * Who's looking, as a People slug, when it's a household owner (loom's `caller`): the owner's tasks are theirs, so
   * they read "you" and wear that person's avatar. Undefined outside a household, or for anyone else.
   */
  viewer?: string;
  /** TASKSTORE_AGENTS, in order: who an answered ask goes back to when the agent that asked isn't known. */
  agents?: string[];
  /** The changes (pull requests) that cite this task, from the Changes piece when it's installed (loom
   * docs/specs/changes.md, "Linked tasks"): the CLI reads them, so this file stays pure. Absent: no section. */
  changes?: ChangeRef[];
}

/** At most this many changes on a task's side column: a side section is a glance, not the list (that's Changes). */
export const CHANGES_SHOWN = 20;

/** A change that cites a task, as `loom-changes cited-by <id> --json` answers it. */
export interface ChangeRef { id: string; short: string; title: string; words: string; page: string }

/** Keep only well-formed rows: another piece's answer is data to check, not trust. */
export function changeRefs(v: unknown): ChangeRef[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is ChangeRef => typeof c === "object" && c !== null
    && ["id", "short", "title", "words", "page"].every((k) => typeof (c as Record<string, unknown>)[k] === "string")
    && /^[a-z0-9._~-]+(\/[a-z0-9._~-]+)*$/.test((c as ChangeRef).page) && !(c as ChangeRef).page.split("/").includes("..")).slice(0, CHANGES_SHOWN);
}

type Block = Record<string, unknown> & { type: string };
/** `place: "side"` puts a section in loom's side column (loom docs/extensions.md, "The page", its "Pages" part): a desktop window's right-hand
 * column, folded at the top of the page on a phone. */
interface Section { id: string; title?: string; tone?: string; place?: "side"; fold?: "open" | "closed"; blocks: Block[] }
export interface Page { title: string; intro?: string; sections: Section[]; /** loom draws it as the "+" beside the title. */ add?: { page: string; label: string } }

export const NOT_FOUND: Page = { title: "Not found", sections: [] };

const MAX_ASKS = 10;
const HISTORY_SHOWN = 100;
const MAX_STR = 2000; // the contract's per-string limit
const TITLE_MAX = 300;
const PROSE_MAX = 20000; // the contract's prose limit
export const COMMENT_MAX = 10000;

// ------------------------------------------------------------- helpers

function clip(s: string, n = MAX_STR): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}


// The contract's path grammar. A task id that doesn't fit it (an imported id
// with capitals, say) gets no link rather than a link that would make loom
// drop the whole answer as invalid.
const PATH_RE = /^[a-z0-9._~/-]{0,200}$/;
function pathOk(p: string): boolean {
  return PATH_RE.test(p) && !p.split("/").includes("..");
}
function taskLink(id: string): { page?: string } {
  const p = `task/${id}`;
  return pathOk(p) ? { page: p } : {};
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const byPriority = (a: { t: Task; i: number }, b: { t: Task; i: number }) =>
  a.t.priority - b.t.priority || a.i - b.i;

function inProgress(v: UiView): Task[] {
  return v.tasks.map((t, i) => ({ t, i })).filter(({ t }) => t.status === "in_progress").sort(byPriority).map(({ t }) => t);
}

/** Open or in-progress tasks assigned to the owner, highest priority first. */
function ownersCall(v: UiView): Task[] {
  return v.tasks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => v.owner !== "" && t.status !== "closed" && t.assignee === v.owner)
    .sort(byPriority)
    .map(({ t }) => t);
}

const urgent = (v: UiView) => v.ready.filter((e) => e.priority <= 1);

/**
 * "12:09 PM" today, "Oct 24, 12:09 PM" another day, "Jan 2, 2025, 9:05 AM"
 * another year; always 12-hour, in the given zone.
 */
export function humanDate(iso: string | undefined, now: Date, timeZone?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions = {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  };
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone });
  } catch {
    // An invalid TZ is a RangeError from Intl; fall back to the system zone.
    f = new Intl.DateTimeFormat("en-US", opts);
  }
  const parts = (x: Date) => {
    const ps = f.formatToParts(x);
    return (t: string) => ps.find((p) => p.type === t)?.value ?? "";
  };
  const get = parts(d);
  const today = parts(now);
  const time = `${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
  if (get("year") !== today("year")) return `${get("month")} ${get("day")}, ${get("year")}, ${time}`;
  if (get("month") === today("month") && get("day") === today("day")) return time;
  return `${get("month")} ${get("day")}, ${time}`;
}

/** Priority in words (0 is highest). */
export const PRIORITY_WORDS = ["Urgent", "High", "Normal", "Low", "Someday"];
export const priorityWord = (n: number) => PRIORITY_WORDS[n] ?? `Priority ${n}`;
/** "Normal priority" (as meta), lowercased mid-phrase. */
const priorityMeta = (n: number) => (PRIORITY_WORDS[n] ? `${PRIORITY_WORDS[n]} priority` : `Priority ${n}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const statusWords = (s: string) => cap(s === "in_progress" ? "in progress" : s);

/** What a task says it's for, on the line under its title: its goal, else that it has none yet. */
export const NO_SUMMARY = "Needs a plain summary";
const goalLine = (t: Task) => t.goal?.trim() || NO_SUMMARY;

/** How the owner answers a task's ask: as it says, else Yes or No when it says what happens either way. */
export function answersOf(t: Task): "yes-no" | "words" {
  if (t.answers) return t.answers;
  return t.ifYes || t.ifNo ? "yes-no" : "words";
}

// ------------------------------------------------------------- manifest

export function manifest(v: UiView) {
  const doing = inProgress(v).length;
  const hot = urgent(v).length;
  return {
    v: 2,
    tab: { label: "Tasks" },
    // Existing task-store visibility is household-only; this does not opt its pages into agent-owner access.
    agents: Object.fromEntries((v.agents ?? []).map((agent) => [agent, { readings: [], jobs: v.tasks
      .filter((t) => t.status !== "closed" && t.type !== "epic" && (t.assignee === agent || (!t.assignee && t.createdBy === agent) || (t.assignee === v.owner && t.askedBy === agent)))
      .map((t) => ({ id: t.id, tasks: [t.id], status: t.assignee === v.owner && t.askedBy === agent ? "waiting" : "backlog", text: clip(t.title, TITLE_MAX), ...taskLink(t.id),
        ...(t.source?.match(/^conversation:cv-[0-9a-f]{12}$/) ? { conversation: t.source.slice(13) } : {}) })) }])),
    tile: {
      label: "Work",
      value: `${doing} in progress`,
      detail: `${hot} ready, urgent or high`,
      ...(hot ? { tone: "warn" } : {}),
      page: "",
    },
    // The ask is the headline and its why the line under it (Jonathan, 2026-11-04: t-1273 read like a log, not a
    // request); a task with no ask yet shows its title and goal.
    asks: ownersCall(v).slice(0, MAX_ASKS).map((t) => ({
      text: clip(t.ask?.trim() || t.title, TITLE_MAX),
      meta: clip(t.ask?.trim() ? (t.why?.trim() || t.goal?.trim() || `${priorityMeta(t.priority)} · ${t.id}`) : (t.goal?.trim() || `${priorityMeta(t.priority)} · ${t.id}`)),
      ...taskLink(t.id),
      label: "Open",
      // Its age on the card: since it was started, else since it was filed.
      at: t.startedAt ?? t.createdAt,
      // A task waiting on the owner: loom's Inbox files it under To do (it was Decisions, with nothing to choose: Jonathan,
      // 2026-10-30). Only an urgent or high-priority task needs the owner now (counted, unread until opened).
      kind: "todo" as const,
      ...(t.priority <= 1 ? {} : { attention: false as const }),
    })),
  };
}

// ------------------------------------------------------------- pages

/** Route a `ui page` request. Anything malformed or unknown is Not found. */
export function page(v: UiView, req: unknown): Page {
  if (!isObj(req) || typeof req.path !== "string" || !pathOk(req.path)) return NOT_FOUND;
  const query = isObj(req.query) ? req.query : {};
  v = { ...v, viewer: viewerOf(req.caller) };
  if (req.path === "") return workPage(v, query);
  if (req.path === "new") return newTaskPage(v);
  const m = /^task\/([^/]+)$/.exec(req.path);
  if (m) return taskPage(v, m[1]);
  return NOT_FOUND;
}

const PRIORITIES = ["0", "1", "2", "3", "4"];
/** A task cited the way loom pages cite each other: [[t-124]]. */
const TASK_REF = /\[\[(t-\d+)\]\]/g;
const PERSON = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** loom's caller (docs/extensions.md, "caller"): a household owner, by their People slug; anyone else isn't "you". */
function viewerOf(caller: unknown): string | undefined {
  if (!isObj(caller) || caller.kind !== "owner" || caller.agents !== "*" || typeof caller.who !== "string") return undefined;
  return PERSON.test(caller.who) && caller.who.length <= 80 ? caller.who : undefined;
}

function shownOf(shown: number, total: number): Block {
  return { type: "text", text: `Shown ${shown} of ${total}.`, tone: "muted" };
}

const DONE_DAYS = 7;
/** A group's rows a page at a time, loom's own page size; each group its own `?<id>=<n>`. */
const GROUP_SHOWN = 15;
const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** An assignee that looks like an agent id: loom draws its mark (an unknown id draws nothing). */
const agentOf = (who?: string) => (who && AGENT_ID.test(who) ? { agent: who } : {});
/** The page itself, when nobody's set as the owner: loom's (its own mark), not a person's or an agent's. */
const PAGE_ACTOR = "loom-page";
/**
 * Who someone is on a row (Jonathan, 2026-10-31: "everything should have one"): the owner wears the viewer's own
 * avatar when the owner is looking (else their initial), the page wears loom's mark, and an agent its own.
 */
const whoOf = (v: UiView, who?: string) =>
  !who ? {}
    : v.owner && who === v.owner ? (v.viewer ? { person: v.viewer } : { avatar: who.slice(0, 1).toUpperCase() })
      : who === PAGE_ACTOR ? { agent: "loom" } : agentOf(who);
/** Who, in words: "you" for the owner while they're the one looking. */
const nameOf = (v: UiView, who?: string) => (who && v.owner && who === v.owner && v.viewer ? "you" : who);

const WEEKS = 8;
const DAY = 86_400_000;

/** Monday 00:00 of `d`'s week, in the page's zone (near enough: the zone's date, at UTC midnight). */
function weekStart(d: Date, timeZone?: string): number {
  const [y, m, day] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d).split("-").map(Number);
  const t = Date.UTC(y, m - 1, day);
  return t - ((new Date(t).getUTCDay() + 6) % 7) * DAY;
}

/**
 * Is the pile growing or shrinking: tasks opened and done each week, the last WEEKS weeks (this one last), as 000h's
 * bar chart (Jonathan, 2026-10-31: the stats "might just be something worth graphing"), and how many are open now.
 * In the side column, slim (Jonathan, 2026-11-05: "we could slim that up to a smaller like right column thing"): loom
 * draws a side chart shorter. The two series name two different colours, and loom draws each name in the legend.
 */
function weeks(v: UiView): Section {
  const now = weekStart(v.now, v.timeZone);
  const first = now - (WEEKS - 1) * 7 * DAY;
  const opened = new Array<number>(WEEKS).fill(0);
  const closed = new Array<number>(WEEKS).fill(0);
  const bucket = (iso?: string) => {
    if (!iso || Number.isNaN(Date.parse(iso))) return -1;
    const w = Math.round((weekStart(new Date(iso), v.timeZone) - first) / (7 * DAY));
    return w >= 0 && w < WEEKS ? w : -1;
  };
  for (const t of v.tasks) {
    const o = bucket(t.createdAt);
    if (o >= 0) opened[o]++;
    const c = t.status === "closed" ? bucket(t.closedAt) : -1;
    if (c >= 0) closed[c]++;
  }
  const label = (i: number) => new Date(first + i * 7 * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const open = v.tasks.filter((t) => t.status !== "closed" && t.type !== "epic").length;
  const net = opened[WEEKS - 1] - closed[WEEKS - 1];
  return {
    id: "weeks", title: "Opened and done", place: "side",
    blocks: [{
      type: "chart", kind: "bar", caption: "By week",
      summary: { label: "Open", value: open.toLocaleString("en-US"), detail: `${net > 0 ? "+" : ""}${net} this week` },
      series: [{ key: "opened", label: "Opened", color: "pink" }, { key: "done", label: "Done", color: "olive" }],
      data: opened.map((n, i) => ({ label: i === WEEKS - 1 ? "This week" : label(i), opened: n, done: closed[i] })),
    }],
  };
}

/** How the work list sorts (its `?sort=`): by how much it matters (the groups' own order), newest first, or the most
 * recently touched first. */
export const SORTS = [{ value: "", label: "Priority" }, { value: "new", label: "Newest" }, { value: "updated", label: "Updated" }];
/** The status chips under the sort (?show=a,b; none on means every group): which groups the list draws. "Open" is the
 * ready queue (up next, ready, later). */
export const SHOWS = [{ value: "yours", label: "Needs you" }, { value: "doing", label: "In progress" }, { value: "blocked", label: "Blocked" },
  { value: "open", label: "Open" }, { value: "done", label: "Done" }] as const;
type Show = (typeof SHOWS)[number]["value"];

/** What a row opens to in place (loom's list `more`, Jonathan's Tasks mock, t-1925): its goal, why and done-when, and
 * Open task. Nothing to show (no summary yet): none, and the row goes straight to the task. */
function moreOf(t: Task, link?: string): { more?: { items: Array<{ label: string; value: string }>; open?: string } } {
  const pairs: Array<[string, string | undefined]> = [["Goal", t.goal], ["Why", t.why], ["Done when", t.doneWhen]];
  const items = pairs.flatMap(([label, value]) => (value?.trim() ? [{ label, value: clip(value.trim()) }] : []));
  return items.length ? { more: { items, ...(link ? { open: "Open task" } : {}) } } : {};
}
/** How many tasks Recently updated lists. */
export const RECENT_SHOWN = 8;

/** When a task last changed, as far as its record says: filed, started, closed, or its latest comment. */
export function touchedAt(t: Task): string {
  let best = t.createdAt, at = Date.parse(t.createdAt);
  for (const x of [t.startedAt, t.closedAt, ...t.comments.map((c) => c.at)]) {
    const n = x ? Date.parse(x) : NaN;
    // (an unreadable createdAt, NaN, gives way to the first stamp that reads)
    if (Number.isFinite(n) && (Number.isNaN(at) || n > at)) { best = x!; at = n; }
  }
  return best;
}
const touched = (t: Task) => Date.parse(touchedAt(t)) || 0;

/**
 * Work, in groups (Jonathan, 2026-10-31: "break the list of tasks into groups ... logical groupings"; the
 * Open · Blocked · Done counts and pills went): waiting on you, in progress, blocked, then the ready queue by
 * how much it matters (up next: urgent and high; ready: normal; later: low and someday), and the last week's
 * done folded at the foot. Each task once, in the first group it fits; an empty group isn't drawn.
 *
 * Beside it, in loom's side column (Jonathan, 2026-11-05): find and sort (`?q=` matches what `taskstore search` does:
 * id, title, description, refs, goal, why and ask; `?sort=` orders each group, one switch; `?show=` chips pick the
 * groups), the opened-and-done chart, and the tasks touched most recently. A row opens in place to its goal, why and
 * done-when (Jonathan's Tasks mock, t-1925).
 */
export function workPage(v: UiView, query: Record<string, unknown>): Page {
  const seen = new Set<string>();
  const take = (t: Task) => (seen.has(t.id) ? false : (seen.add(t.id), true));
  const tasks = new Map(v.tasks.map((t) => [t.id, t]));
  const ready = v.ready.map((e) => tasks.get(e.id)).filter((t): t is Task => !!t);
  const blockers = (t: Task) => v.links.filter((l) => l.type === "blocks" && l.id === t.id && tasks.get(l.dependsOn)?.status !== "closed").map((l) => l.dependsOn);
  const find = typeof query.q === "string" ? query.q.trim() : "";
  const needle = find.toLowerCase();
  const sort = typeof query.sort === "string" && SORTS.some((o) => o.value === query.sort) ? query.sort : "";
  const matches = (t: Task) => !needle || SEARCH_FIELDS.some((f) => {
    const x = (t as unknown as Record<string, unknown>)[f];
    return typeof x === "string" && x.toLowerCase().includes(needle);
  });
  const created = (t: Task) => Date.parse(t.createdAt) || 0;
  /** A group's tasks that match, in the order asked for (the group's own, by default). */
  const matchingInOrder = (ts: Task[]) => {
    const m = ts.filter(matches);
    return sort === "new" ? m.sort((a, b) => created(b) - created(a)) : sort === "updated" ? m.sort((a, b) => touched(b) - touched(a)) : m;
  };
  const since = v.now.getTime() - DONE_DAYS * 86_400_000;
  const done = v.tasks.filter((t) => t.status === "closed" && t.closedAt && Date.parse(t.closedAt) >= since)
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));

  // No tone dot on a row: its group already says whether it's blocked, later or done (Jonathan, 2026-10-31).
  // The plain title, and its goal as the second line (Jonathan, 2026-11-04: "if I can't understand it from the task
  // list, I can't know if we're doing the right thing"); the facts follow the goal.
  // A row opens in place to its goal, why and done-when, with Open task inside (Jonathan's Tasks mock, t-1925).
  const linked = (t: Task) => { const l = taskLink(t.id); return { ...l, ...moreOf(t, l.page) }; };
  const row = (t: Task, meta: Array<string | false | undefined>) => ({
    text: clip(t.title, TITLE_MAX), meta: clip([goalLine(t), ...meta].filter(Boolean).join(" · ")), ...whoOf(v, t.assignee), ...linked(t),
  });
  const askRow = (t: Task, meta: Array<string | false | undefined>) => (t.ask?.trim()
    ? { text: clip(t.ask, TITLE_MAX), meta: clip([t.why?.trim() || t.goal?.trim(), ...meta].filter(Boolean).join(" · ")), ...whoOf(v, t.assignee), ...linked(t) }
    : row(t, meta));
  const who = (t: Task) => nameOf(v, t.assignee);
  const pri = (t: Task) => priorityWord(t.priority);
  const sections: Section[] = [];
  // Each group folds under its title (Jonathan, 2026-10-31: "can we make the groups collapsible?"): what needs a look
  // starts open, the long tail of the queue starts folded; loom keeps each viewer's own open and close after that.
  // The status chips (?show=): a group whose chip is off isn't drawn (its tasks are still taken, so none moves into
  // another group).
  const shows = new Set<string>((typeof query.show === "string" ? query.show : "").split(",").filter((x) => SHOWS.some((o) => o.value === x)));
  const group = (id: string, show: Show, title: string, rows: Array<Record<string, unknown>>, tone?: string, fold: "open" | "closed" = "open") => {
    if (!rows.length || (shows.size && !shows.has(show))) return;
    const count = Math.ceil(rows.length / GROUP_SHOWN);
    const want = Number(typeof query[id] === "string" ? query[id] : 1);
    const at = Number.isInteger(want) && want >= 1 && want <= count ? want : 1;
    const items = rows.slice((at - 1) * GROUP_SHOWN, at * GROUP_SHOWN);
    sections.push({
      id, title: `${title} · ${rows.length}`, ...(tone ? { tone } : {}), fold,
      // `who`: every row says whose it is, nobody's included (loom draws that as a dashed circle).
      blocks: [{ type: "list", who: true, items, ...(count > 1 ? { pages: { param: id, at, count, total: rows.length } } : {}) }],
    });
  };

  group("yours", "yours", "Waiting on you", matchingInOrder(ownersCall(v)).filter(take).map((t) => askRow(t, [who(t), pri(t), t.id])), "warn");
  group("doing", "doing", "In progress", matchingInOrder(inProgress(v)).filter(take).map((t) => row(t, [who(t), pri(t), t.id])));
  const blocked = v.tasks.filter((t) => t.status === "open" && t.type !== "epic" && blockers(t).length).sort((a, b) => a.priority - b.priority);
  group("blocked", "blocked", "Blocked", matchingInOrder(blocked).filter(take).map((t) => {
    const on = blockers(t);
    return row(t, [who(t), `Waiting on ${on.slice(0, 3).join(", ")}${on.length > 3 ? "…" : ""}`, pri(t), t.id]);
  }));
  group("next", "open", "Up next", matchingInOrder(ready.filter((t) => t.priority <= 1)).filter(take).map((t) => row(t, [who(t), pri(t), t.id])));
  group("ready", "open", "Ready", matchingInOrder(ready.filter((t) => t.priority === 2)).filter(take).map((t) => row(t, [who(t), t.id])), undefined, "closed");
  group("later", "open", "Later", matchingInOrder(ready.filter((t) => t.priority >= 3)).filter(take).map((t) => row(t, [who(t), pri(t), t.id])), undefined, "closed");
  group("done", "done", `Done in the last ${DONE_DAYS} days`, matchingInOrder(done)
    .map((t) => row(t, [who(t), pri(t), t.id, humanDate(t.closedAt, v.now, v.timeZone)])), undefined, "closed");
  const nothing = find ? `Nothing matches “${clip(find, 80)}”.` : shows.size ? "Nothing here. Turn another chip on." : "Nothing open.";
  if (!sections.length) sections.push({ id: "empty", blocks: [{ type: "text", text: nothing, tone: "muted" }] });

  // The side column: find and sort first (it changes the list), the chart, then what moved last.
  const recent = v.tasks.filter((t) => t.type !== "epic").sort((a, b) => touched(b) - touched(a)).slice(0, RECENT_SHOWN);
  const side: Section[] = [
    { id: "show", title: "Find and sort", place: "side", blocks: [{ type: "filters", param: "sort", search: "Find a task", switch: true, options: SORTS.map((o) => ({ ...o })),
      chips: [{ param: "show", label: "Status", options: SHOWS.map((o) => ({ ...o })) }] }] },
    weeks(v),
    ...(recent.length ? [{ id: "recent", title: "Recently updated", place: "side" as const, blocks: [{ type: "list", items: recent.map((t) => ({
      text: clip(t.title, TITLE_MAX), meta: clip(`${t.id} · ${t.status === "open" && blockers(t).length ? "Blocked" : statusWords(t.status)} · ${humanDate(touchedAt(t), v.now, v.timeZone)}`),
      ...whoOf(v, t.assignee), ...taskLink(t.id) })) }] }] : []),
  ];

  return { title: "Tasks", ...(find ? { intro: `Finding “${clip(find, 80)}”` } : {}), add: { page: "new", label: "New task" }, sections: [...sections, ...side] };
}

function isBlocked(v: UiView, id: string): boolean {
  return v.links.some((l) => l.type === "blocks" && l.id === id && v.tasks.find((t) => t.id === l.dependsOn)?.status !== "closed");
}

/** The conversation a task came from, when its source names one (conversation:cv-<12 hex>). */
export function fromConversation(t: Task): string | undefined {
  return /^conversation:(cv-[0-9a-f]{12})$/.exec(t.source ?? "")?.[1];
}

export function taskPage(v: UiView, id: string): Page {
  const t = v.tasks.find((x) => x.id === id);
  if (!t) return NOT_FOUND;
  const from = fromConversation(t);
  const date = (s?: string) => humanDate(s, v.now, v.timeZone);
  const title = (tid: string) => v.tasks.find((x) => x.id === tid)?.title;

  const status = t.status === "open" && isBlocked(v, t.id) ? "Open (blocked)" : statusWords(t.status);
  // The task's facts as an app's panel (Jonathan, 2026-11-03: "app panels, not web forms"): each row says the value
  // in words; priority changes in place (a segmented control); links go to the tasks they name; the raw refs sit
  // behind one row's sheet.
  const rows: Array<Record<string, unknown>> = [
    { label: "Status", value: status, ...(t.status === "closed" ? { tone: "ok" } : t.status === "in_progress" ? { tone: "warn" } : {}) },
    PRIORITIES.includes(String(t.priority))
      // In a sheet: five segments don't fit beside the label in the side column (they squeezed it to a letter a line).
      ? { label: "Priority", value: priorityWord(t.priority),
          edit: { action: "priority", title: "Priority", submit: "Set", hidden: { id: t.id },
            fields: [{ name: "priority", label: "How urgent", kind: "segmented", value: String(t.priority),
              options: PRIORITIES.map((value) => ({ value, label: priorityWord(Number(value)) })) }] } }
      : { label: "Priority", value: priorityWord(t.priority) },
    ...(t.type !== "task" ? [{ label: "Kind", value: cap(t.type) }] : []),
    { label: "Whose", value: clip(nameOf(v, t.assignee) ?? "Nobody's yet"), ...(t.assignee !== v.owner ? agentOf(t.assignee) : {}) },
    { label: "Opened", value: date(t.createdAt), detail: clip(`by ${t.createdBy}`) },
    ...(t.startedAt ? [{ label: "Started", value: date(t.startedAt) }] : []),
    ...(t.closedAt ? [{ label: "Closed", value: date(t.closedAt), ...(t.closeReason ? { detail: clip(t.closeReason) } : {}) }] : []),
  ];
  const parent = v.links.find((l) => l.type === "parent-child" && l.id === t.id)?.dependsOn;
  if (parent) rows.push({ label: "Part of", value: clip(title(parent) ?? parent, TITLE_MAX), detail: parent, ...taskLink(parent) });
  const deps = v.links.filter((l) => l.type === "blocks" && l.id === t.id).map((l) => l.dependsOn);
  for (const d of deps.slice(0, 20)) {
    const dt = v.tasks.find((x) => x.id === d);
    rows.push({ label: "Waits on", value: clip(dt?.title ?? d, TITLE_MAX), detail: `${d}${dt?.status === "closed" ? " · done" : ""}`,
      tone: dt?.status === "closed" ? "ok" : "warn", ...taskLink(d) });
  }
  if (deps.length > 20) rows.push({ label: "Waits on", value: `and ${deps.length - 20} more` });
  const record = [["Task", t.id], ["Spec item", t.specItemRef], ["Criterion", t.criterionId], ["Legacy ref", t.legacyRef]] as const;
  rows.push({ label: "Record", value: "Its ids and refs", sheet: { title: t.id, blocks: [{ type: "kv",
    items: record.filter(([, val]) => val).map(([label, val]) => ({ label, value: clip(val as string) })) }] } });

  // Tasks cite each other as [[t-NNN]], which loom's prose would read as a knowledge page (a dead link): they read
  // as plain t-NNN, and the ones that exist are listed under Mentioned, linked to their own pages.
  const mentioned: string[] = [];
  const unlink = (s: string) => s.replace(TASK_REF, (_, id: string) => {
    if (id !== t.id && !mentioned.includes(id) && v.tasks.some((x) => x.id === id)) mentioned.push(id);
    return id;
  });
  const description = t.description ? unlink(t.description) : "";
  const comments = t.comments.slice(-HISTORY_SHOWN).map((c) => ({ ...c, text: unlink(c.text) }));

  const yours = v.owner !== "" && t.status !== "closed" && t.assignee === v.owner;
  const ask = t.ask?.trim();
  // The board's Task, plain words first (Jonathan, 2026-11-04): the ask when there is one (Ask, Why, If yes, If no,
  // and its answer, if it's yours), the goal, why and done-when, then the description as written folded under
  // Background, then Mark done, or Reopen once it's closed.
  const summary = [["Goal", t.goal], ["Why", ask ? undefined : t.why], ["Done when", t.doneWhen]]
    .filter(([, x]) => x?.trim()).map(([k, x]) => `**${k}:** ${unlink(x!.trim())}`);
  const main: Block[] = [
    // The owner's task with no ask yet: still theirs to answer, in the reply below.
    ...(yours && !ask ? [{ type: "callout", title: "Waiting on you", text: "Your answer goes in the reply below; it's picked up from there.", tone: "warn" }] : []),
    summary.length ? { type: "prose", text: summary.join("\n\n").slice(0, PROSE_MAX) }
      : { type: "text", text: description ? "Needs a plain summary: nobody has said what this is for in plain words yet. What's written is under Background." : "Needs a plain summary.", tone: "muted" },
    { type: "buttons", items: [t.status === "closed"
      ? { action: "reopen", label: "Reopen", fields: { id: t.id } }
      : { action: "close", label: "Mark done", ...(yours && ask ? {} : { tone: "primary" }), fields: { id: t.id } }] },
  ];

  // The ask: a question, why, and what happens either way. The owner's answers it here: Yes or No (a yes/no ask), or
  // in their own words, in one form, so words typed beside a Yes go with it (loom keeps them until they're sent).
  const askSection: Section[] = ask ? [{
    id: "ask", title: yours ? "Waiting on you" : t.status === "closed" ? "It asked" : `Asked of ${nameOf(v, v.owner) ?? "the owner"}`,
    ...(yours ? { tone: "warn" } : {}),
    blocks: [
      { type: "callout", title: clip(ask), text: clip(t.why?.trim() || "No why given."), ...(yours ? { tone: "warn" } : {}) },
      ...([["If yes", t.ifYes], ["If no", t.ifNo]].some(([, x]) => x?.trim())
        ? [{ type: "prose", text: [["If yes", t.ifYes], ["If no", t.ifNo]].filter(([, x]) => x?.trim()).map(([k, x]) => `**${k}:** ${unlink(x!.trim())}`).join("\n\n") }]
        : []),
      ...(yours ? [answerForm(v, t)] : []),
    ],
  }] : [];

  const history: Block[] = comments.length
    ? [
      { type: "list", wrap: true, items: comments.map((c) => ({ text: clip(c.text), meta: clip(`${c.actor === PAGE_ACTOR ? "loom" : nameOf(v, c.actor)} · ${date(c.at)}`), ...whoOf(v, c.actor) })) },
      ...(t.comments.length > comments.length ? [shownOf(comments.length, t.comments.length)] : []),
    ]
    : [{ type: "text", text: "No comments yet.", tone: "muted" }];

  // Background: the description as written. Folded once there's a plain summary or an ask to read first; open when
  // it's all there is.
  const background: Section[] = description ? [{
    id: "background", title: "Background", fold: summary.length || ask ? "closed" : "open",
    blocks: [{ type: "prose", text: description.slice(0, PROSE_MAX) }],
  }] : [];
  const answering = yours && !!ask;

  return {
    title: clip(t.title),
    intro: `${status} · ${priorityMeta(t.priority)} · ${t.id}`,
    sections: [
      ...askSection,
      { id: "task", blocks: main },
      ...background,
      ...(mentioned.length ? [{ id: "mentioned", title: "Mentioned", blocks: [{ type: "list", items: mentioned.slice(0, 50).map((id) => {
        const m = v.tasks.find((x) => x.id === id)!;
        return { text: clip(m.title, TITLE_MAX), meta: `${id} · ${m.status === "open" && isBlocked(v, id) ? "Open (blocked)" : statusWords(m.status)}`, ...whoOf(v, m.assignee), ...taskLink(id) };
      }) }] }] : []),
      { id: "comments", title: "Comments", blocks: history },
      // The ask's own form answers it; a task with no ask (or not the owner's) has the plain Reply.
      ...(answering ? [] : [{ id: "reply", blocks: [{
        type: "form", action: "comment", title: "Reply", submit: "Send",
        hidden: { id: t.id },
        fields: [{ name: "text", label: yours ? "Your call" : "Reply", kind: "textarea", required: true, hint: `Posted as ${v.owner || "loom-page"}.` }],
      }] }]),
      { id: "facts", place: "side", blocks: [{ type: "panel", rows }] },
      // Where it came from (it-ts-source): loom draws the block, and only the thread's own member sees its title and
      // link (loom docs/specs/comms.md, "From"). Only a conversation source has one.
      ...(from ? [{ id: "from", place: "side" as const, blocks: [{ type: "from", conversation: from }] }] : []),
      ...(v.changes?.length ? [{ id: "changes", title: "Changes", place: "side" as const, blocks: [{ type: "list", items: v.changes.map((c) => ({
        text: clip(`${c.short} ${c.title}`, TITLE_MAX), meta: clip(c.words), page: `loom:p/changes/${c.page}` })) }] }] : []),
    ],
  };
}

/**
 * The owner's answer to a task's ask: one form, so nothing typed is lost to a button (loom#479's guard). A yes/no ask
 * has Yes and No as its submits, each sending whatever words are in the box with it, and Send for words alone; an
 * ask answered in words has Send only. loom keeps the box's words on the device until they're sent.
 */
function answerForm(v: UiView, t: Task): Block {
  const yesNo = answersOf(t) === "yes-no";
  return {
    type: "form", action: "answer", submit: "Send", hidden: { id: t.id },
    ...(yesNo ? { submits: [
      { label: "Yes", fields: { answer: "yes" }, tone: "primary" },
      { label: "No", fields: { answer: "no" } },
    ] } : {}),
    fields: [{ name: "text", label: yesNo ? "Or answer in your own words" : "Your answer", kind: "textarea", ...(yesNo ? {} : { required: true }),
      hint: `It goes back to ${cap(agentFor(v, t))} as your comment, posted as ${v.owner}.` }],
  };
}

/** Who an answered ask goes back to: the agent that asked, else the first of the store's agents, else art. */
export function agentFor(v: Pick<UiView, "owner" | "agents">, t: Task): string {
  const asked = t.askedBy?.trim();
  if (asked && asked !== v.owner && AGENT_ID.test(asked) && asked !== PAGE_ACTOR) return asked;
  return v.agents?.[0] ?? "art";
}

/** What the owner's answer says on the task, as their comment: the answer, the ask, and its own line for it. */
export function answerText(t: Task, answer: "yes" | "no" | undefined, words: string): string {
  const ask = t.ask?.trim() ?? "";
  if (!answer) return `Answer, to: ${ask}\n\n${words}`;
  const line = answer === "yes" ? t.ifYes?.trim() : t.ifNo?.trim();
  return `${answer === "yes" ? "Yes" : "No"}, to: ${ask}${line ? `\nIf ${answer}, you said: ${line}` : ""}${words ? `\n\n${words}` : ""}`;
}

/** The board's "+": a task's title, how urgent, whose, and a note. */
export function newTaskPage(v: UiView): Page {
  return {
    title: "New task",
    sections: [{ id: "new", blocks: [{
      type: "form", action: "create", submit: "Create task",
      fields: [
        { name: "title", label: "Title", kind: "text", required: true, hint: `${TITLE_MAX} characters at most.` },
        { name: "priority", label: "Priority", kind: "choice", value: "2",
          options: ["1", "2", "3", "4"].map((value) => ({ value, label: priorityWord(Number(value)) })) },
        ...(v.owner ? [{ name: "mine", label: "Whose", kind: "choice", value: "",
          options: [{ value: "", label: "The agents'" }, { value: "1", label: "Mine" }] }] : []),
        { name: "description", label: "Notes", kind: "textarea" },
      ],
    }] }],
  };
}

// ------------------------------------------------------------- actions

export type ActCheck =
  | { ok: true; action: "create"; title: string; priority: number; description?: string; mine: boolean }
  | { ok: true; action: "comment"; id: string; text: string }
  | { ok: true; action: "close" | "reopen"; id: string }
  | { ok: true; action: "priority"; id: string; priority: number }
  | { ok: true; action: "answer"; id: string; text: string; to: string; answer?: "yes" | "no" }
  | { ok: false; message: string };

/** Validate a `ui act` request: comment, close (Mark done), reopen (its Undo). loom passes fields through unchecked. */
export function checkAct(v: UiView, req: unknown): ActCheck {
  if (!isObj(req)) return { ok: false, message: "That request couldn't be read." };
  if (req.action === "create") {
    const f = isObj(req.fields) ? req.fields : {};
    const title = typeof f.title === "string" ? f.title.trim() : "";
    if (!title) return { ok: false, message: "A task needs a title." };
    if (title.length > TITLE_MAX) return { ok: false, message: `The title is ${title.length} characters; the limit is ${TITLE_MAX}.` };
    const priority = typeof f.priority === "string" && PRIORITIES.includes(f.priority) ? Number(f.priority) : 2;
    const description = typeof f.description === "string" && f.description.trim() ? f.description.trim().slice(0, COMMENT_MAX) : undefined;
    return { ok: true, action: "create", title, priority, ...(description ? { description } : {}), mine: f.mine === "1" && v.owner !== "" };
  }
  if (req.action !== "comment" && req.action !== "close" && req.action !== "reopen" && req.action !== "priority" && req.action !== "answer") return { ok: false, message: "taskstore doesn't know that action." };
  const fields = isObj(req.fields) ? req.fields : {};
  const id = fields.id;
  const task = typeof id === "string" ? v.tasks.find((t) => t.id === id) : undefined;
  if (typeof id !== "string" || !task) return { ok: false, message: "That task doesn't exist." };
  if (req.action === "close") return task.status === "closed" ? { ok: false, message: "It's already done." } : { ok: true, action: "close", id };
  if (req.action === "priority") {
    const p = fields.priority;
    if (typeof p !== "string" || !PRIORITIES.includes(p)) return { ok: false, message: "That isn't a priority." };
    return { ok: true, action: "priority", id, priority: Number(p) };
  }
  if (req.action === "reopen") return task.status !== "closed" ? { ok: false, message: "It isn't closed." } : { ok: true, action: "reopen", id };
  if (req.action === "answer") {
    if (!task.ask?.trim()) return { ok: false, message: "That task doesn't ask anything." };
    if (v.owner === "" || task.assignee !== v.owner || task.status === "closed") return { ok: false, message: "That ask isn't waiting on you any more: it was answered, or it's done." };
    const a = fields.answer;
    if (a !== undefined && a !== "" && a !== "yes" && a !== "no") return { ok: false, message: "An answer is Yes or No." };
    const answer = a === "yes" || a === "no" ? a : undefined;
    if (answer && answersOf(task) !== "yes-no") return { ok: false, message: "This one needs your words, not a Yes or a No." };
    const words = typeof fields.text === "string" ? fields.text.trim() : "";
    if (!answer && !words) return { ok: false, message: "Your answer is empty." };
    const text = answerText(task, answer, words);
    if (text.length > COMMENT_MAX) return { ok: false, message: `Your answer is ${words.length} characters; the limit is about ${COMMENT_MAX}.` };
    return { ok: true, action: "answer", id, text, to: agentFor(v, task), ...(answer ? { answer } : {}) };
  }
  const text = typeof fields.text === "string" ? fields.text.trim() : "";
  if (!text) return { ok: false, message: "The comment is empty." };
  if (text.length > COMMENT_MAX)
    return { ok: false, message: `The comment is ${text.length} characters; the limit is ${COMMENT_MAX}.` };
  return { ok: true, action: "comment", id, text };
}
