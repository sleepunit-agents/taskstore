// The felag-tasks (c-tasks) WorkLayer over the taskstore — mapping only,
// per ac-task-shim-thin: propose -> create (linkage idempotency is native),
// report -> report (the projection is native, including closed+"cancelled"
// -> cancelled), transition -> reopen/claim/close. The layer supplies the
// clock and attribution for contract-side transitions, which c-tasks
// fixtures never observe.

import { apply, emptyState, type Command, type StoreState } from "./core.js";

export interface ProposalResult {
  accepted: boolean;
  created: boolean;
  taskRef: string | null;
  errors: string[];
}

export interface ReportEntry {
  taskRef: string;
  specItemRef: string;
  criterionId?: string;
  status: "open" | "in_progress" | "done" | "cancelled";
}

const REQUIRED = ["specItemRef", "title", "attribution", "at"] as const;

const TRANSITION: Record<string, { op: string; reason?: string }> = {
  open: { op: "reopen" },
  in_progress: { op: "claim" },
  done: { op: "close" },
  cancelled: { op: "close", reason: "cancelled" },
};

export class TaskstoreWorkLayer {
  private state: StoreState;

  constructor(
    state?: StoreState,
    private clock: string = "2026-06-12T00:00:00Z",
    private attribution: string = "felag-tasks-layer",
  ) {
    this.state = state ?? emptyState();
  }

  snapshot(): StoreState {
    return this.state;
  }

  private run(command: Command): Record<string, unknown> {
    const { result, state } = apply(this.state, command);
    this.state = state;
    return result;
  }

  propose(proposal: Record<string, unknown>): ProposalResult {
    const missing = REQUIRED.filter((f) => typeof proposal[f] !== "string");
    if (missing.length > 0) {
      return { accepted: false, created: false, taskRef: null, errors: ["E_MISSING_FIELD"] };
    }
    const cmd: Command = {
      op: "create",
      title: proposal.title,
      specItemRef: proposal.specItemRef,
      actor: proposal.attribution,
      at: proposal.at,
    };
    if (typeof proposal.criterionId === "string") cmd.criterionId = proposal.criterionId;
    if (typeof proposal.description === "string") cmd.description = proposal.description;
    const r = this.run(cmd);
    if (r.ok !== true) {
      return { accepted: false, created: false, taskRef: null, errors: r.errors as string[] };
    }
    return { accepted: true, created: r.created as boolean, taskRef: r.id as string, errors: [] };
  }

  report(): { entries: ReportEntry[] } {
    const r = this.run({ op: "report" });
    return { entries: r.entries as ReportEntry[] };
  }

  transition(taskRef: string, to: string): { ok: boolean } {
    const t = TRANSITION[to];
    if (!t) return { ok: false };
    const cmd: Command = { op: t.op, id: taskRef, actor: this.attribution, at: this.clock };
    if (t.reason !== undefined) cmd.reason = t.reason;
    return { ok: this.run(cmd).ok === true };
  }
}
