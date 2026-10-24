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
export interface Page { title: string; intro?: string; sections: Section[] }

export const NOT_FOUND: Page = { title: "Not found", sections: [] };

const MAX_ASKS = 10;
const LIST_SHOWN = 50;
const HISTORY_SHOWN = 100;
const MAX_STR = 2000; // the contract's per-string limit
const TITLE_MAX = 300;
export const COMMENT_MAX = 10000;

// ------------------------------------------------------------- helpers

function clip(s: string, n = MAX_STR): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Split long text into contract-sized strings (a text block per chunk). */
function chunks(s: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length && out.length < max; i += MAX_STR) out.push(s.slice(i, i + MAX_STR));
  if (out.length * MAX_STR < s.length) out[out.length - 1] = out[out.length - 1].slice(0, MAX_STR - 1) + "…";
  return out;
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
    })),
  };
}

// ------------------------------------------------------------- pages

/** Route a `ui page` request. Anything malformed or unknown is Not found. */
export function page(v: UiView, req: unknown): Page {
  if (!isObj(req) || typeof req.path !== "string" || !pathOk(req.path)) return NOT_FOUND;
  const query = isObj(req.query) ? req.query : {};
  if (req.path === "") return workPage(v, query);
  const m = /^task\/([^/]+)$/.exec(req.path);
  if (m) return taskPage(v, m[1]);
  return NOT_FOUND;
}

const PRIORITIES = ["0", "1", "2", "3", "4"];

function shownOf(shown: number, total: number): Block {
  return { type: "text", text: `Shown ${shown} of ${total}.`, tone: "muted" };
}

export function workPage(v: UiView, query: Record<string, unknown>): Page {
  // The filter is priority, a real field on every task. "" (or anything
  // that isn't 0-4) means all; with no filter the ready list is p0-p1.
  const pq = typeof query.priority === "string" && PRIORITIES.includes(query.priority) ? Number(query.priority) : undefined;
  const allDoing = inProgress(v);
  const doing = pq === undefined ? allDoing : allDoing.filter((t) => t.priority === pq);
  const readyHere = pq === undefined ? urgent(v) : v.ready.filter((e) => e.priority === pq);
  const at = pq === undefined ? "" : ` at p${pq}`;
  const assignee = new Map(v.tasks.map((t) => [t.id, t.assignee]));

  const sections: Section[] = [];
  const mine = ownersCall(v);
  if (mine.length) {
    const shown = mine.slice(0, LIST_SHOWN);
    sections.push({
      id: "yours", title: "Your call", tone: "warn",
      blocks: [
        { type: "list", items: shown.map((t) => ({ text: clip(t.title, TITLE_MAX), meta: `${t.id} · p${t.priority}`, ...taskLink(t.id) })) },
        ...(mine.length > shown.length ? [shownOf(shown.length, mine.length)] : []),
      ],
    });
  }

  sections.push({
    id: "summary",
    blocks: [
      { type: "stats", items: [
        { label: "In progress", value: String(allDoing.length) },
        { label: "Ready", value: String(v.ready.length) },
        { label: "Ready at p0–p1", value: String(urgent(v).length), ...(urgent(v).length ? { tone: "warn" } : {}) },
      ] },
      { type: "filters", param: "priority", options: [
        { value: "", label: "All" },
        ...PRIORITIES.map((p) => ({ value: p, label: `p${p}` })),
      ] },
    ],
  });

  const doingShown = doing.slice(0, LIST_SHOWN);
  sections.push({
    id: "in-progress", title: `In progress${at}`,
    blocks: doing.length
      ? [
        { type: "list", items: doingShown.map((t) => ({
          text: clip(t.title, TITLE_MAX),
          meta: `${t.id} · p${t.priority}${t.assignee ? ` · ${t.assignee}` : ""}`,
          ...taskLink(t.id),
        })) },
        shownOf(doingShown.length, doing.length),
      ]
      : [{ type: "text", text: `Nothing in progress${at}.`, tone: "muted" }],
  });

  const readyShown = readyHere.slice(0, LIST_SHOWN);
  sections.push({
    id: "ready", title: pq === undefined ? "Ready at p0–p1" : `Ready${at}`,
    blocks: readyHere.length
      ? [
        { type: "list", items: readyShown.map((e) => {
          const who = assignee.get(e.id);
          return { text: clip(e.title, TITLE_MAX), meta: `${e.id} · p${e.priority}${who ? ` · ${who}` : ""}`, ...taskLink(e.id) };
        }) },
        shownOf(readyShown.length, readyHere.length),
      ]
      : [{ type: "text", text: `Nothing ready${pq === undefined ? " at p0–p1" : at}.`, tone: "muted" }],
  });

  return {
    title: "Work",
    intro: pq === undefined ? "What's moving, and what's ready to pick up next." : `Only p${pq} work.`,
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
  const main: Block[] = [
    { type: "link", text: "← Work", page: "" },
    ...(yours ? [{ type: "callout", title: "Your call", text: "This one is waiting on you. Add your decision as a comment below, and it's picked up from there.", tone: "warn" }] : []),
    ...(t.description
      ? chunks(t.description, 17).map((c) => ({ type: "text", text: c }))
      : [{ type: "text", text: "No description.", tone: "muted" }]),
  ];

  const comments = t.comments.slice(-HISTORY_SHOWN);
  const history: Block[] = comments.length
    ? [
      { type: "list", items: comments.map((c) => ({ text: clip(c.text), meta: clip(`${c.actor} · ${date(c.at)}`) })) },
      ...(t.comments.length > comments.length ? [shownOf(comments.length, t.comments.length)] : []),
    ]
    : [{ type: "text", text: "No comments yet.", tone: "muted" }];

  return {
    title: clip(t.title),
    intro: `${t.id} · ${status} · p${t.priority}`,
    sections: [
      { id: "task", blocks: main },
      { id: "history", title: "History", blocks: history },
      { id: "comment", blocks: [{
        type: "form", action: "comment", title: "Add a comment", submit: "Comment",
        hidden: { id: t.id },
        fields: [{ name: "text", label: "Comment", kind: "textarea", required: true, hint: `Posted as ${v.owner || "loom-page"}.` }],
      }] },
      { id: "facts", side: true, blocks: [{ type: "kv", items: kv }] },
    ],
  };
}

// ------------------------------------------------------------- actions

export type ActCheck =
  | { ok: true; id: string; text: string }
  | { ok: false; message: string };

/** Validate a `ui act` request. Only "comment" exists; loom passes fields through unchecked. */
export function checkAct(v: UiView, req: unknown): ActCheck {
  if (!isObj(req)) return { ok: false, message: "That request couldn't be read." };
  if (req.action !== "comment") return { ok: false, message: "taskstore doesn't know that action." };
  const fields = isObj(req.fields) ? req.fields : {};
  const id = fields.id;
  if (typeof id !== "string" || !v.tasks.some((t) => t.id === id)) return { ok: false, message: "That task doesn't exist." };
  const text = typeof fields.text === "string" ? fields.text.trim() : "";
  if (!text) return { ok: false, message: "The comment is empty." };
  if (text.length > COMMENT_MAX)
    return { ok: false, message: `The comment is ${text.length} characters; the limit is ${COMMENT_MAX}.` };
  return { ok: true, id, text };
}
