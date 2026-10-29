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
}

type Block = Record<string, unknown> & { type: string };
interface Section { id: string; title?: string; tone?: string; side?: boolean; blocks: Block[] }
export interface Page { title: string; intro?: string; sections: Section[]; /** loom draws it as the "+" beside the title. */ add?: { page: string; label: string } }

export const NOT_FOUND: Page = { title: "Not found", sections: [] };

const MAX_ASKS = 10;
const LIST_SHOWN = 50;
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

/** "Sat Oct 24, 12:09 pm"; the year joins in when it isn't this one. */
export function humanDate(iso: string | undefined, now: Date, timeZone?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let parts: Intl.DateTimeFormatPart[];
  let year: string;
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  };
  try {
    const f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone });
    parts = f.formatToParts(d);
    year = f.formatToParts(now).find((p) => p.type === "year")?.value ?? "";
  } catch {
    // An invalid TZ is a RangeError from Intl; fall back to the system zone.
    const f = new Intl.DateTimeFormat("en-US", opts);
    parts = f.formatToParts(d);
    year = f.formatToParts(now).find((p) => p.type === "year")?.value ?? "";
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = get("year") !== year ? ` ${get("year")}` : "";
  return `${get("weekday")} ${get("month")} ${get("day")}${y}, ${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()}`;
}

const statusWords = (s: string) => (s === "in_progress" ? "in progress" : s);

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
      detail: `${hot} ready at p0–p1`,
      ...(hot ? { tone: "warn" } : {}),
      page: "",
    },
    asks: ownersCall(v).slice(0, MAX_ASKS).map((t) => ({
      text: clip(t.title, TITLE_MAX),
      meta: `${t.id} · p${t.priority}`,
      ...taskLink(t.id),
      label: "Open",
      // Its age on the card: since it was started, else since it was filed.
      at: t.startedAt ?? t.createdAt,
      // loom's Inbox files it under Decisions; only a p0–p1 task needs the owner now (counted, unread until opened).
      kind: "decision" as const,
      ...(t.priority <= 1 ? {} : { attention: false as const }),
    })),
  };
}

// ------------------------------------------------------------- pages

/** Route a `ui page` request. Anything malformed or unknown is Not found. */
export function page(v: UiView, req: unknown): Page {
  if (!isObj(req) || typeof req.path !== "string" || !pathOk(req.path)) return NOT_FOUND;
  const query = isObj(req.query) ? req.query : {};
  if (req.path === "") return workPage(v, query);
  if (req.path === "new") return newTaskPage(v);
  const m = /^task\/([^/]+)$/.exec(req.path);
  if (m) return taskPage(v, m[1]);
  return NOT_FOUND;
}

const PRIORITIES = ["0", "1", "2", "3", "4"];

function shownOf(shown: number, total: number): Block {
  return { type: "text", text: `Shown ${shown} of ${total}.`, tone: "muted" };
}

const SHOWS = ["", "blocked", "done"];
const DONE_DAYS = 7;
const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** An assignee that looks like an agent id: loom draws its mark (an unknown id draws nothing). */
const agentOf = (who?: string) => (who && AGENT_ID.test(who) ? { agent: who } : {});
/** A comment's lead: the owner's initial in a circle (a person, not an agent), else the agent's mark. */
const whoOf = (v: UiView, who: string) => (v.owner && who === v.owner ? { avatar: who.slice(0, 1).toUpperCase() } : agentOf(who));

/**
 * Work, per the board: Open · Blocked · Done counts, the same three as pills,
 * then the rows — the owner's own first (waiting on you), then in progress,
 * then ready in priority order. `priority` still narrows, as before.
 */
export function workPage(v: UiView, query: Record<string, unknown>): Page {
  const show = typeof query.show === "string" && SHOWS.includes(query.show) ? query.show : "";
  const pq = typeof query.priority === "string" && PRIORITIES.includes(query.priority) ? Number(query.priority) : undefined;
  const at = pq === undefined ? "" : ` at p${pq}`;
  const byP = (t: Task) => pq === undefined || t.priority === pq;
  const open = v.tasks.filter((t) => t.status !== "closed");
  const blocked = open.filter((t) => t.status === "open" && isBlocked(v, t.id));
  const since = v.now.getTime() - DONE_DAYS * 86_400_000;
  const done = v.tasks.filter((t) => t.status === "closed" && t.closedAt && Date.parse(t.closedAt) >= since)
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
  const mine = ownersCall(v);

  const sections: Section[] = [{
    id: "summary",
    blocks: [
      { type: "stats", items: [
        { label: "Open", value: String(open.length - blocked.length), page: "" },
        { label: "Blocked", value: String(blocked.length), ...(blocked.length ? { tone: "warn" } : {}), page: "?show=blocked" },
        { label: `Done · ${DONE_DAYS}d`, value: String(done.length), page: "?show=done" },
      ] },
      { type: "filters", param: "show", options: [{ value: "", label: "Open" }, { value: "blocked", label: "Blocked" }, { value: "done", label: "Done" }] },
    ],
  }];

  const row = (t: Task, meta: string, tone?: string) => ({
    text: clip(t.title, TITLE_MAX), meta: clip(`${meta} · ${t.id} · p${t.priority}`), ...(tone ? { tone } : {}), ...agentOf(t.assignee), ...taskLink(t.id),
  });
  // A page of LIST_SHOWN at a time: ?page=<n> (from 1), the list saying where it is so loom draws the pager
  // (loom docs/extensions.md, "pages"). The filters ride along: loom keeps the page's other query keys.
  const want = Number(typeof query.page === "string" ? query.page : 1);
  const list = (id: string, title: string | undefined, all: Array<Record<string, unknown>>, empty: string) => {
    const count = Math.max(1, Math.ceil(all.length / LIST_SHOWN));
    const at = Number.isInteger(want) && want >= 1 && want <= count ? want : 1;
    const items = all.slice((at - 1) * LIST_SHOWN, at * LIST_SHOWN);
    sections.push({
      id, ...(title ? { title } : {}),
      blocks: items.length ? [{ type: "list", items, ...(count > 1 ? { pages: { param: "page", at, count, total: all.length } } : {}) }] : [{ type: "text", text: empty, tone: "muted" }],
    });
  };

  if (show === "blocked") {
    const rows = blocked.filter(byP).map((t) => {
      const on = v.links.filter((l) => l.type === "blocks" && l.id === t.id && v.tasks.find((x) => x.id === l.dependsOn)?.status !== "closed").map((l) => l.dependsOn);
      return row(t, `blocked by ${on.slice(0, 3).join(", ")}${on.length > 3 ? "…" : ""}`, "muted");
    });
    list("blocked", `Blocked${at}`, rows, `Nothing blocked${at}.`);
  } else if (show === "done") {
    const rows = done.filter(byP).map((t) => row(t, `done ${humanDate(t.closedAt, v.now, v.timeZone)}`, "ok"));
    list("done", `Done in the last ${DONE_DAYS} days${at}`, rows, `Nothing done in the last ${DONE_DAYS} days${at}.`);
  } else {
    const seen = new Set<string>();
    const take = (t: Task) => (seen.has(t.id) ? false : (seen.add(t.id), true));
    const yours = mine.filter(byP).filter(take).map((t) => row(t, "waiting on you", "warn"));
    const doing = inProgress(v).filter(byP).filter(take).map((t) => row(t, `working on it${t.assignee ? ` · ${t.assignee}` : ""}`));
    const tasks = new Map(v.tasks.map((t) => [t.id, t]));
    const ready = v.ready.filter((e) => pq === undefined || e.priority === pq).map((e) => tasks.get(e.id)).filter((t): t is Task => !!t).filter(take)
      .map((t) => row(t, "ready"));
    const all = [...yours, ...doing, ...ready];
    list("open", pq === undefined ? undefined : `Open${at}`, all, `Nothing open${at}.`);
  }

  return {
    title: "Tasks",
    add: { page: "new", label: "New task" },
    intro: show === "blocked" ? "Waiting on something else first." : show === "done" ? "What got finished lately." : "What's waiting on you, what's moving, and what's ready next.",
    sections,
  };
}

function isBlocked(v: UiView, id: string): boolean {
  return v.links.some((l) => l.type === "blocks" && l.id === id && v.tasks.find((t) => t.id === l.dependsOn)?.status !== "closed");
}

export function taskPage(v: UiView, id: string): Page {
  const t = v.tasks.find((x) => x.id === id);
  if (!t) return NOT_FOUND;
  const date = (s?: string) => humanDate(s, v.now, v.timeZone);
  const title = (tid: string) => v.tasks.find((x) => x.id === tid)?.title;

  const status = t.status === "open" && isBlocked(v, t.id) ? "open (blocked)" : statusWords(t.status);
  const kv: Array<Record<string, string>> = [
    { label: "status", value: status },
    { label: "priority", value: `p${t.priority}` },
    ...(t.type !== "task" ? [{ label: "type", value: t.type }] : []),
    { label: "assignee", value: clip(t.assignee ?? "nobody") },
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
      { type: "list", items: comments.map((c) => ({ text: clip(c.text), meta: clip(`${c.actor} · ${date(c.at)}`), ...whoOf(v, c.actor) })) },
      ...(t.comments.length > comments.length ? [shownOf(comments.length, t.comments.length)] : []),
    ]
    : [{ type: "text", text: "No comments yet.", tone: "muted" }];

  return {
    title: clip(t.title),
    intro: `${t.id} · ${status} · p${t.priority}`,
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
          options: [{ value: "1", label: "p1" }, { value: "2", label: "p2" }, { value: "3", label: "p3" }, { value: "4", label: "p4" }] },
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
