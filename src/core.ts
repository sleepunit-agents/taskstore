// taskstore-core reference implementation — the pure transition function.
// apply: (state, command) -> {result, state}. No I/O, no wall clock, no
// invented attribution: everything observable is determined by the command
// sequence (it-ts-model). Persistence, CLI, and scheduling are bindings.

export type TaskType = "task" | "bug" | "feature" | "epic";
export type TaskStatus = "open" | "in_progress" | "closed";
export type LinkType = "blocks" | "parent-child";

export interface Comment {
  actor: string;
  at: string;
  text: string;
}

export interface Task {
  id: string;
  title: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  createdAt: string;
  createdBy: string;
  comments: Comment[];
  description?: string;
  assignee?: string;
  startedAt?: string;
  closedAt?: string;
  closeReason?: string;
  legacyRef?: string;
  specItemRef?: string;
  criterionId?: string;
}

export interface Link {
  id: string;
  dependsOn: string;
  type: LinkType;
}

export interface StoreState {
  tasks: Task[];
  links: Link[];
  seq: number;
}

export const emptyState = (): StoreState => ({ tasks: [], links: [], seq: 0 });

export type Command = { op: string } & Record<string, unknown>;
export type Result = Record<string, unknown>;

const TYPES: readonly string[] = ["task", "bug", "feature", "epic"];
const STATUSES: readonly string[] = ["open", "in_progress", "closed"];
const LINK_TYPES: readonly string[] = ["blocks", "parent-child"];
const UPDATABLE: readonly string[] = ["assignee", "description", "priority", "title"];

// "Parseable" per felag-core it-verification's Timestamps rule (incorporated
// by reference in it-ts-model): RFC 3339 date-time, case-insensitive T/Z,
// numeric offset or Z REQUIRED, second 60 excluded.
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function parseable(s: string): boolean {
  const m = RFC3339.exec(s);
  if (!m) return false;
  if (m[3] === "60") return false;
  return !Number.isNaN(Date.parse(s.toUpperCase()));
}

const isString = (v: unknown): v is string => typeof v === "string";
const isPriority = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

class Errs {
  private codes = new Set<string>();
  add(code: string): void {
    this.codes.add(code);
  }
  get any(): boolean {
    return this.codes.size > 0;
  }
  list(): string[] {
    return [...this.codes].sort();
  }
}

/** Required string field: absent or mistyped -> E_MISSING_FIELD. */
function reqString(errs: Errs, v: unknown): v is string {
  if (!isString(v)) {
    errs.add("E_MISSING_FIELD");
    return false;
  }
  return true;
}

/** Required timestamp: E_MISSING_FIELD when absent/mistyped, E_BAD_TIMESTAMP when unparseable. */
function reqAt(errs: Errs, v: unknown): boolean {
  if (!reqString(errs, v)) return false;
  if (!parseable(v)) {
    errs.add("E_BAD_TIMESTAMP");
    return false;
  }
  return true;
}

/** Optional string field: present but mistyped -> E_BAD_FIELD. */
function optString(errs: Errs, v: unknown): boolean {
  if (v !== undefined && !isString(v)) {
    errs.add("E_BAD_FIELD");
    return false;
  }
  return true;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

const linkageKey = (specItemRef: string, criterionId: string | undefined): string =>
  `${specItemRef} ${criterionId ?? ""}`;

function findTask(state: StoreState, id: string): Task | undefined {
  return state.tasks.find((t) => t.id === id);
}

/** Would adding edge from->to create a directed cycle in `type`'s graph? */
function wouldCycle(links: Link[], from: string, to: string, type: LinkType): boolean {
  if (from === to) return true;
  // cycle iff `to` already reaches `from` along type edges (id -> dependsOn)
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const l of links) if (l.type === type && l.id === cur) stack.push(l.dependsOn);
  }
  return false;
}

function blockedIds(state: StoreState): Set<string> {
  const blocked = new Set<string>();
  for (const l of state.links) {
    if (l.type !== "blocks") continue;
    const blocker = findTask(state, l.dependsOn);
    if (blocker && blocker.status !== "closed") blocked.add(l.id);
  }
  return blocked;
}

function showShape(state: StoreState, t: Task): Record<string, unknown> {
  const out: Record<string, unknown> = { ...t };
  out.dependsOn = state.links
    .filter((l) => l.type === "blocks" && l.id === t.id)
    .map((l) => l.dependsOn);
  const parent = state.links.find((l) => l.type === "parent-child" && l.id === t.id);
  if (parent) out.parent = parent.dependsOn;
  return out;
}

function listEntry(state: StoreState, t: Task): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: t.id,
    priority: t.priority,
    status: t.status,
    title: t.title,
    type: t.type,
  };
  const parent = state.links.find((l) => l.type === "parent-child" && l.id === t.id);
  if (parent) entry.parent = parent.dependsOn;
  return entry;
}

const contractStatus = (t: Task): string =>
  t.status === "closed" ? (t.closeReason === "cancelled" ? "cancelled" : "done") : t.status;

function freshId(state: StoreState): string {
  let id: string;
  do {
    state.seq += 1;
    id = `t-${state.seq}`;
  } while (findTask(state, id) !== undefined);
  return id;
}

// ------------------------------------------------------------------ apply

export function apply(prev: StoreState, command: Command): { result: Result; state: StoreState } {
  const state = clone(prev);
  const result = dispatch(state, command);
  // Per-command atomicity: any error means the state is unchanged.
  if (result.ok === false) return { result, state: prev };
  return { result, state };
}

function dispatch(state: StoreState, c: Command): Result {
  switch (c.op) {
    case "create":
      return doCreate(state, c);
    case "claim":
      return doLifecycle(state, c, "claim");
    case "close":
      return doLifecycle(state, c, "close");
    case "reopen":
      return doLifecycle(state, c, "reopen");
    case "update":
      return doUpdate(state, c);
    case "comment":
      return doComment(state, c);
    case "link":
      return doLink(state, c);
    case "show":
      return doShow(state, c);
    case "list":
      return doList(state, c);
    case "ready":
      return doReady(state);
    case "report":
      return doReport(state);
    case "export":
      return doExport(state);
    case "import":
      return doImport(state, c);
    default:
      return { errors: ["E_BAD_FIELD"], ok: false };
  }
}

function doCreate(state: StoreState, c: Command): Result {
  const errs = new Errs();
  reqString(errs, c.title);
  reqString(errs, c.actor);
  reqAt(errs, c.at);
  optString(errs, c.description);
  optString(errs, c.parent);
  optString(errs, c.specItemRef);
  optString(errs, c.criterionId);
  optString(errs, c.legacyRef);
  if (c.type !== undefined && !(isString(c.type) && TYPES.includes(c.type)))
    errs.add("E_BAD_TYPE");
  if (c.priority !== undefined && !isPriority(c.priority)) errs.add("E_BAD_PRIORITY");
  if (c.criterionId !== undefined && c.specItemRef === undefined) errs.add("E_MISSING_FIELD");
  if (isString(c.parent) && findTask(state, c.parent) === undefined) errs.add("E_UNKNOWN_ID");
  if (errs.any) return { created: false, errors: errs.list(), id: null, ok: false };

  // Linkage idempotency: a held (specItemRef, criterionId) key returns the
  // existing task, whatever its status; the new proposal is discarded.
  if (isString(c.specItemRef)) {
    const key = linkageKey(c.specItemRef, c.criterionId as string | undefined);
    const existing = state.tasks.find(
      (t) => t.specItemRef !== undefined && linkageKey(t.specItemRef, t.criterionId) === key,
    );
    if (existing) return { created: false, errors: [], id: existing.id, ok: true };
  }

  const id = freshId(state);
  const task: Task = {
    id,
    title: c.title as string,
    type: (c.type as TaskType | undefined) ?? "task",
    status: "open",
    priority: (c.priority as number | undefined) ?? 2,
    createdAt: c.at as string,
    createdBy: c.actor as string,
    comments: [],
  };
  if (c.description !== undefined) task.description = c.description as string;
  if (c.legacyRef !== undefined) task.legacyRef = c.legacyRef as string;
  if (c.specItemRef !== undefined) task.specItemRef = c.specItemRef as string;
  if (c.criterionId !== undefined) task.criterionId = c.criterionId as string;
  state.tasks.push(task);
  if (isString(c.parent)) state.links.push({ id, dependsOn: c.parent, type: "parent-child" });
  return { created: true, errors: [], id, ok: true };
}

function doLifecycle(state: StoreState, c: Command, kind: "claim" | "close" | "reopen"): Result {
  const errs = new Errs();
  reqString(errs, c.id);
  reqString(errs, c.actor);
  reqAt(errs, c.at);
  if (kind === "close") optString(errs, c.reason);
  const task = isString(c.id) ? findTask(state, c.id) : undefined;
  if (isString(c.id) && task === undefined) errs.add("E_UNKNOWN_ID");
  // Transition legality interrogates the referent: evaluated only when the
  // task exists; co-fires with any field errors (it-ts-lifecycle).
  if (task) {
    if (kind === "claim" && task.status !== "open") errs.add("E_BAD_TRANSITION");
    if (kind === "close" && task.status === "closed") errs.add("E_BAD_TRANSITION");
    if (kind === "reopen" && task.status !== "closed") errs.add("E_BAD_TRANSITION");
  }
  if (errs.any) return { errors: errs.list(), ok: false };

  const t = task!;
  if (kind === "claim") {
    t.status = "in_progress";
    t.assignee = c.actor as string;
    t.startedAt = c.at as string;
  } else if (kind === "close") {
    t.status = "closed";
    t.closedAt = c.at as string;
    if (c.reason !== undefined) t.closeReason = c.reason as string;
  } else {
    t.status = "open";
    delete t.startedAt;
    delete t.assignee;
    delete t.closedAt;
    delete t.closeReason;
  }
  return { errors: [], ok: true };
}

function doUpdate(state: StoreState, c: Command): Result {
  const errs = new Errs();
  reqString(errs, c.id);
  reqString(errs, c.actor);
  reqAt(errs, c.at);
  if (!isPlainObject(c.set) || Object.keys(c.set).length === 0) {
    errs.add("E_MISSING_FIELD");
  } else {
    for (const [k, v] of Object.entries(c.set)) {
      if (!UPDATABLE.includes(k)) errs.add("E_BAD_FIELD");
      else if (k === "priority") {
        if (!isPriority(v)) errs.add("E_BAD_PRIORITY");
      } else if (!isString(v)) errs.add("E_BAD_FIELD");
    }
  }
  const task = isString(c.id) ? findTask(state, c.id) : undefined;
  if (isString(c.id) && task === undefined) errs.add("E_UNKNOWN_ID");
  if (errs.any) return { errors: errs.list(), ok: false };

  const set = c.set as Record<string, unknown>;
  const t = task!;
  if (set.title !== undefined) t.title = set.title as string;
  if (set.description !== undefined) t.description = set.description as string;
  if (set.priority !== undefined) t.priority = set.priority as number;
  if (set.assignee !== undefined) t.assignee = set.assignee as string;
  return { errors: [], ok: true };
}

function doComment(state: StoreState, c: Command): Result {
  const errs = new Errs();
  reqString(errs, c.id);
  reqString(errs, c.actor);
  reqAt(errs, c.at);
  reqString(errs, c.text);
  const task = isString(c.id) ? findTask(state, c.id) : undefined;
  if (isString(c.id) && task === undefined) errs.add("E_UNKNOWN_ID");
  if (errs.any) return { errors: errs.list(), ok: false };
  task!.comments.push({ actor: c.actor as string, at: c.at as string, text: c.text as string });
  return { errors: [], ok: true };
}

function doLink(state: StoreState, c: Command): Result {
  const errs = new Errs();
  reqString(errs, c.id);
  reqString(errs, c.dependsOn);
  reqString(errs, c.actor);
  reqAt(errs, c.at);
  let type: LinkType | undefined;
  if (!isString(c.type)) errs.add("E_MISSING_FIELD");
  else if (!LINK_TYPES.includes(c.type)) errs.add("E_BAD_TYPE");
  else type = c.type as LinkType;
  const from = isString(c.id) ? findTask(state, c.id) : undefined;
  const to = isString(c.dependsOn) ? findTask(state, c.dependsOn) : undefined;
  if ((isString(c.id) && from === undefined) || (isString(c.dependsOn) && to === undefined))
    errs.add("E_UNKNOWN_ID");

  // Referent-interrogating checks: need both referents and a valid type.
  if (from && to && type) {
    const dup = state.links.some(
      (l) => l.id === from.id && l.dependsOn === to.id && l.type === type,
    );
    if (dup) {
      if (errs.any) return { errors: errs.list(), ok: false };
      return { errors: [], ok: true }; // accepted no-op, precedes all semantic checks
    }
    if (
      type === "parent-child" &&
      state.links.some((l) => l.type === "parent-child" && l.id === from.id)
    )
      errs.add("E_HAS_PARENT");
    if (wouldCycle(state.links, from.id, to.id, type)) errs.add("E_CYCLE");
  }
  if (errs.any) return { errors: errs.list(), ok: false };
  state.links.push({ id: from!.id, dependsOn: to!.id, type: type! });
  return { errors: [], ok: true };
}

function doShow(state: StoreState, c: Command): Result {
  const errs = new Errs();
  reqString(errs, c.id);
  const task = isString(c.id) ? findTask(state, c.id) : undefined;
  if (isString(c.id) && task === undefined) errs.add("E_UNKNOWN_ID");
  if (errs.any) return { errors: errs.list(), ok: false, task: null };
  return { errors: [], ok: true, task: showShape(state, task!) };
}

function doList(state: StoreState, c: Command): Result {
  if (c.status !== undefined && !(isString(c.status) && STATUSES.includes(c.status)))
    return { entries: [], errors: ["E_BAD_FIELD"], ok: false };
  const entries = state.tasks
    .filter((t) => c.status === undefined || t.status === c.status)
    .map((t) => listEntry(state, t));
  return { entries, errors: [], ok: true };
}

function doReady(state: StoreState): Result {
  const blocked = blockedIds(state);
  const entries = state.tasks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.status === "open" && t.type !== "epic" && !blocked.has(t.id))
    .sort((a, b) => a.t.priority - b.t.priority || a.i - b.i)
    .map(({ t }) => ({ id: t.id, priority: t.priority, title: t.title, type: t.type }));
  return { entries, errors: [], ok: true };
}

function doReport(state: StoreState): Result {
  const entries = state.tasks
    .filter((t) => t.specItemRef !== undefined)
    .map((t) => ({
      ...(t.criterionId !== undefined ? { criterionId: t.criterionId } : {}),
      specItemRef: t.specItemRef!,
      status: contractStatus(t),
      taskRef: t.id,
    }))
    .sort((a, b) => {
      if (a.specItemRef !== b.specItemRef) return a.specItemRef < b.specItemRef ? -1 : 1;
      const ac = a.criterionId ?? "";
      const bc = b.criterionId ?? "";
      if (ac !== bc) return ac < bc ? -1 : 1; // absent sorts first
      return a.taskRef < b.taskRef ? -1 : 1;
    });
  return { entries, errors: [], ok: true };
}

function doExport(state: StoreState): Result {
  return {
    errors: [],
    links: clone(state.links),
    ok: true,
    tasks: state.tasks.map((t) => clone(t)),
  };
}

function doImport(state: StoreState, c: Command): Result {
  const errs = new Errs();
  reqString(errs, c.actor);
  reqAt(errs, c.at);
  if (!Array.isArray(c.tasks)) {
    errs.add("E_MISSING_FIELD");
    return { errors: errs.list(), imported: 0, ok: false };
  }
  if (c.links !== undefined && !Array.isArray(c.links)) errs.add("E_BAD_FIELD");
  const payloadLinks = Array.isArray(c.links) ? c.links : [];

  const payloadIds = new Set<string>();
  const payloadKeys = new Set<string>();
  const heldKeys = new Set(
    state.tasks
      .filter((t) => t.specItemRef !== undefined)
      .map((t) => linkageKey(t.specItemRef!, t.criterionId)),
  );

  for (const raw of c.tasks) {
    if (!isPlainObject(raw)) {
      errs.add("E_MISSING_FIELD");
      continue;
    }
    const r = raw;
    for (const f of ["createdAt", "createdBy", "id", "title"])
      if (!isString(r[f])) errs.add("E_MISSING_FIELD");
    if (!isString(r.type)) errs.add("E_MISSING_FIELD");
    else if (!TYPES.includes(r.type)) errs.add("E_BAD_TYPE");
    if (!isString(r.status)) errs.add("E_MISSING_FIELD");
    else if (!STATUSES.includes(r.status)) errs.add("E_BAD_FIELD");
    if (typeof r.priority !== "number") errs.add("E_MISSING_FIELD");
    else if (!isPriority(r.priority)) errs.add("E_BAD_PRIORITY");
    for (const f of ["createdAt", "startedAt", "closedAt"]) {
      const v = r[f];
      if (v === undefined) continue;
      if (!isString(v)) {
        if (f !== "createdAt") errs.add("E_BAD_FIELD");
      } else if (!parseable(v)) errs.add("E_BAD_TIMESTAMP");
    }
    for (const f of ["description", "assignee", "closeReason", "legacyRef", "specItemRef", "criterionId"])
      optString(errs, r[f]);
    if (r.criterionId !== undefined && r.specItemRef === undefined) errs.add("E_MISSING_FIELD");
    if (r.parent !== undefined || r.dependsOn !== undefined) errs.add("E_BAD_FIELD");
    if (r.comments !== undefined) {
      if (!Array.isArray(r.comments)) errs.add("E_BAD_FIELD");
      else
        for (const cm of r.comments) {
          if (!isPlainObject(cm)) {
            errs.add("E_MISSING_FIELD");
            continue;
          }
          for (const f of ["actor", "text"]) if (!isString(cm[f])) errs.add("E_MISSING_FIELD");
          if (!isString(cm.at)) errs.add("E_MISSING_FIELD");
          else if (!parseable(cm.at)) errs.add("E_BAD_TIMESTAMP");
        }
    }
    if (isString(r.id)) {
      if (payloadIds.has(r.id) || findTask(state, r.id) !== undefined) errs.add("E_DUP_ID");
      payloadIds.add(r.id);
    }
    if (isString(r.specItemRef)) {
      const key = linkageKey(r.specItemRef, isString(r.criterionId) ? r.criterionId : undefined);
      if (payloadKeys.has(key) || heldKeys.has(key)) errs.add("E_DUP_LINKAGE");
      payloadKeys.add(key);
    }
  }

  // Link validation over the union of held and payload ids.
  const knows = (id: string): boolean => payloadIds.has(id) || findTask(state, id) !== undefined;
  const prospective: Link[] = [...state.links];
  for (const raw of payloadLinks) {
    if (!isPlainObject(raw)) {
      errs.add("E_MISSING_FIELD");
      continue;
    }
    const l = raw;
    for (const f of ["id", "dependsOn"]) if (!isString(l[f])) errs.add("E_MISSING_FIELD");
    let type: LinkType | undefined;
    if (!isString(l.type)) errs.add("E_MISSING_FIELD");
    else if (!LINK_TYPES.includes(l.type)) errs.add("E_BAD_TYPE");
    else type = l.type as LinkType;
    if ((isString(l.id) && !knows(l.id)) || (isString(l.dependsOn) && !knows(l.dependsOn)))
      errs.add("E_UNKNOWN_ID");
    if (isString(l.id) && knows(l.id) && isString(l.dependsOn) && knows(l.dependsOn) && type) {
      const dup = prospective.some(
        (p) => p.id === l.id && p.dependsOn === l.dependsOn && p.type === type,
      );
      if (dup) continue; // accepted no-op
      if (
        type === "parent-child" &&
        prospective.some((p) => p.type === "parent-child" && p.id === l.id)
      )
        errs.add("E_HAS_PARENT");
      if (wouldCycle(prospective, l.id, l.dependsOn, type)) errs.add("E_CYCLE");
      prospective.push({ id: l.id, dependsOn: l.dependsOn, type });
    }
  }

  if (errs.any) return { errors: errs.list(), imported: 0, ok: false };

  for (const raw of c.tasks as Record<string, unknown>[]) {
    const task: Task = {
      id: raw.id as string,
      title: raw.title as string,
      type: raw.type as TaskType,
      status: raw.status as TaskStatus,
      priority: raw.priority as number,
      createdAt: raw.createdAt as string,
      createdBy: raw.createdBy as string,
      comments: (raw.comments as Comment[] | undefined)?.map((cm) => ({ ...cm })) ?? [],
    };
    for (const f of [
      "description", "assignee", "startedAt", "closedAt", "closeReason",
      "legacyRef", "specItemRef", "criterionId",
    ] as const)
      if (raw[f] !== undefined) (task as Record<string, unknown>)[f] = raw[f];
    state.tasks.push(task);
  }
  state.links = prospective;
  return { errors: [], imported: (c.tasks as unknown[]).length, ok: true };
}
