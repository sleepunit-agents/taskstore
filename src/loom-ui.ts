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

import type { Link, Task } from "./core.js";

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
}

type Block = Record<string, unknown> & { type: string };
interface Section { id: string; title?: string; tone?: string; side?: boolean; fold?: "open" | "closed"; blocks: Block[] }
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

// ------------------------------------------------------------- manifest

export function manifest(v: UiView) {
  const doing = inProgress(v).length;
  const hot = urgent(v).length;
  return {
    v: 2,
    tab: { label: "Tasks" },
    tile: {
      label: "Work",
      value: `${doing} in progress`,
      detail: `${hot} ready, urgent or high`,
      ...(hot ? { tone: "warn" } : {}),
      page: "",
    },
    asks: ownersCall(v).slice(0, MAX_ASKS).map((t) => ({
      text: clip(t.title, TITLE_MAX),
      meta: `${priorityMeta(t.priority)} · ${t.id}`,
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
    id: "weeks",
    blocks: [{
      type: "chart", kind: "bar", caption: "Opened and done, by week",
      summary: { label: "Open", value: open.toLocaleString("en-US"), detail: `${net > 0 ? "+" : ""}${net} this week` },
      series: [{ key: "opened", label: "Opened", color: "pink" }, { key: "done", label: "Done", color: "olive" }],
      data: opened.map((n, i) => ({ label: i === WEEKS - 1 ? "This week" : label(i), opened: n, done: closed[i] })),
    }],
  };
}

/**
 * Work, in groups (Jonathan, 2026-10-31: "break the list of tasks into groups ... logical groupings"; the
 * Open · Blocked · Done counts and pills went): waiting on you, in progress, blocked, then the ready queue by
 * how much it matters (up next: urgent and high; ready: normal; later: low and someday), and the last week's
 * done folded at the foot. Each task once, in the first group it fits; an empty group isn't drawn.
 */
export function workPage(v: UiView, query: Record<string, unknown>): Page {
  const seen = new Set<string>();
  const take = (t: Task) => (seen.has(t.id) ? false : (seen.add(t.id), true));
  const tasks = new Map(v.tasks.map((t) => [t.id, t]));
  const ready = v.ready.map((e) => tasks.get(e.id)).filter((t): t is Task => !!t);
  const blockers = (t: Task) => v.links.filter((l) => l.type === "blocks" && l.id === t.id && tasks.get(l.dependsOn)?.status !== "closed").map((l) => l.dependsOn);
  const since = v.now.getTime() - DONE_DAYS * 86_400_000;
  const done = v.tasks.filter((t) => t.status === "closed" && t.closedAt && Date.parse(t.closedAt) >= since)
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));

  const row = (t: Task, meta: Array<string | false | undefined>, tone?: string) => ({
    text: clip(t.title, TITLE_MAX), meta: clip(meta.filter(Boolean).join(" · ")), ...(tone ? { tone } : {}), ...whoOf(v, t.assignee), ...taskLink(t.id),
  });
  const who = (t: Task) => nameOf(v, t.assignee);
  const pri = (t: Task) => priorityWord(t.priority);
  const sections: Section[] = [weeks(v)];
  // Each group folds under its title (Jonathan, 2026-10-31: "can we make the groups collapsible?"): what needs a look
  // starts open, the long tail of the queue starts folded; loom keeps each viewer's own open and close after that.
  const group = (id: string, title: string, rows: Array<Record<string, unknown>>, tone?: string, fold: "open" | "closed" = "open") => {
    if (!rows.length) return;
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

  group("yours", "Waiting on you", ownersCall(v).filter(take).map((t) => row(t, [who(t), pri(t), t.id])), "warn");
  group("doing", "In progress", inProgress(v).filter(take).map((t) => row(t, [who(t), pri(t), t.id])));
  const blocked = v.tasks.filter((t) => t.status === "open" && t.type !== "epic" && blockers(t).length).sort((a, b) => a.priority - b.priority);
  group("blocked", "Blocked", blocked.filter(take).map((t) => {
    const on = blockers(t);
    return row(t, [`Waiting on ${on.slice(0, 3).join(", ")}${on.length > 3 ? "…" : ""}`, pri(t), t.id], "muted");
  }));
  group("next", "Up next", ready.filter((t) => t.priority <= 1).filter(take).map((t) => row(t, [who(t), pri(t), t.id])));
  group("ready", "Ready", ready.filter((t) => t.priority === 2).filter(take).map((t) => row(t, [who(t), t.id])), undefined, "closed");
  group("later", "Later", ready.filter((t) => t.priority >= 3).filter(take).map((t) => row(t, [who(t), pri(t), t.id], "muted")), undefined, "closed");
  group("done", `Done in the last ${DONE_DAYS} days`, done
    .map((t) => row(t, [who(t), `Done ${humanDate(t.closedAt, v.now, v.timeZone)}`, t.id], "ok")), undefined, "closed");
  if (sections.length === 1) sections.push({ id: "empty", blocks: [{ type: "text", text: "Nothing open.", tone: "muted" }] });

  return { title: "Tasks", add: { page: "new", label: "New task" }, sections };
}

function isBlocked(v: UiView, id: string): boolean {
  return v.links.some((l) => l.type === "blocks" && l.id === id && v.tasks.find((t) => t.id === l.dependsOn)?.status !== "closed");
}

export function taskPage(v: UiView, id: string): Page {
  const t = v.tasks.find((x) => x.id === id);
  if (!t) return NOT_FOUND;
  const date = (s?: string) => humanDate(s, v.now, v.timeZone);
  const title = (tid: string) => v.tasks.find((x) => x.id === tid)?.title;

  const status = t.status === "open" && isBlocked(v, t.id) ? "Open (blocked)" : statusWords(t.status);
  const kv: Array<Record<string, string>> = [
    { label: "status", value: status },
    { label: "priority", value: priorityWord(t.priority) },
    ...(t.type !== "task" ? [{ label: "type", value: t.type }] : []),
    { label: "assignee", value: clip(nameOf(v, t.assignee) ?? "nobody") },
    { label: "opened", value: clip(`${date(t.createdAt)} by ${t.createdBy}`) },
    ...(t.startedAt ? [{ label: "started", value: date(t.startedAt) }] : []),
    ...(t.closedAt ? [{ label: "closed", value: clip(`${date(t.closedAt)}${t.closeReason ? ` (${t.closeReason})` : ""}`) }] : []),
  ];
  const parent = v.links.find((l) => l.type === "parent-child" && l.id === t.id)?.dependsOn;
  if (parent) kv.push({ label: "parent", value: clip(`${parent} ${title(parent) ?? ""}`.trim(), TITLE_MAX), ...taskLink(parent) });
  const deps = v.links.filter((l) => l.type === "blocks" && l.id === t.id).map((l) => l.dependsOn);
  for (const d of deps.slice(0, 20)) {
    const dt = v.tasks.find((x) => x.id === d);
    kv.push({ label: "depends on", value: clip(`${d}${dt ? ` ${dt.title}` : ""}${dt?.status === "closed" ? " (closed)" : ""}`, TITLE_MAX), ...taskLink(d) });
  }
  if (deps.length > 20) kv.push({ label: "depends on", value: `and ${deps.length - 20} more` });
  for (const [label, val] of [["spec item", t.specItemRef], ["criterion", t.criterionId], ["legacy ref", t.legacyRef]] as const)
    if (val) kv.push({ label, value: clip(val) });

  const yours = v.owner !== "" && t.status !== "closed" && t.assignee === v.owner;
  // The board's Task: the ask (if it's yours), the description as written
  // (markdown, a prose block), then Mark done — or Reopen once it's closed.
  const main: Block[] = [
    ...(yours ? [{ type: "callout", title: "Waiting on you", text: "Your answer goes in the reply below; it's picked up from there.", tone: "warn" }] : []),
    t.description ? { type: "prose", text: t.description.slice(0, PROSE_MAX) } : { type: "text", text: "No description.", tone: "muted" },
    { type: "buttons", items: [t.status === "closed"
      ? { action: "reopen", label: "Reopen", fields: { id: t.id } }
      : { action: "close", label: "Mark done", tone: "primary", fields: { id: t.id } }] },
  ];

  const comments = t.comments.slice(-HISTORY_SHOWN);
  const history: Block[] = comments.length
    ? [
      { type: "list", items: comments.map((c) => ({ text: clip(c.text), meta: clip(`${c.actor === PAGE_ACTOR ? "loom" : nameOf(v, c.actor)} · ${date(c.at)}`), ...whoOf(v, c.actor) })) },
      ...(t.comments.length > comments.length ? [shownOf(comments.length, t.comments.length)] : []),
    ]
    : [{ type: "text", text: "No comments yet.", tone: "muted" }];

  return {
    title: clip(t.title),
    intro: `${status} · ${priorityMeta(t.priority)} · ${t.id}`,
    sections: [
      { id: "task", blocks: main },
      { id: "comments", title: "Comments", blocks: history },
      { id: "reply", blocks: [{
        type: "form", action: "comment", title: "Reply", submit: "Send",
        hidden: { id: t.id },
        fields: [{ name: "text", label: yours ? "Your call" : "Reply", kind: "textarea", required: true, hint: `Posted as ${v.owner || "loom-page"}.` }],
      }] },
      { id: "facts", side: true, blocks: [{ type: "kv", items: kv }] },
    ],
  };
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
  if (req.action !== "comment" && req.action !== "close" && req.action !== "reopen") return { ok: false, message: "taskstore doesn't know that action." };
  const fields = isObj(req.fields) ? req.fields : {};
  const id = fields.id;
  const task = typeof id === "string" ? v.tasks.find((t) => t.id === id) : undefined;
  if (typeof id !== "string" || !task) return { ok: false, message: "That task doesn't exist." };
  if (req.action === "close") return task.status === "closed" ? { ok: false, message: "It's already done." } : { ok: true, action: "close", id };
  if (req.action === "reopen") return task.status !== "closed" ? { ok: false, message: "It isn't closed." } : { ok: true, action: "reopen", id };
  const text = typeof fields.text === "string" ? fields.text.trim() : "";
  if (!text) return { ok: false, message: "The comment is empty." };
  if (text.length > COMMENT_MAX)
    return { ok: false, message: `The comment is ${text.length} characters; the limit is ${COMMENT_MAX}.` };
  return { ok: true, action: "comment", id, text };
}
