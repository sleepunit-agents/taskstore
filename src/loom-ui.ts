// taskstore's sections on loom's page (loom docs/extensions.md, "UI sections"):
// `loom tasks ui --json`. Presentation only, built from the read windows
// (ready, list --status in_progress); never a mutation, so nothing lands in
// the interaction log or the export mirror.

interface Entry { id: string; title: string; priority?: number; assignee?: string | null }

const SHOWN = 10;

function clip(s: string, n = 160): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function items(entries: Entry[], meta: (e: Entry) => string) {
  return entries.slice(0, SHOWN).map((e) => ({ text: `${e.id} ${clip(e.title)}`, meta: meta(e) }));
}

export function uiSections(ready: Entry[], inProgress: Entry[]) {
  const byPriority = [...ready].sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9) || a.id.localeCompare(b.id, "en", { numeric: true }));
  const urgent = ready.filter((e) => (e.priority ?? 9) <= 1).length;
  const more = (n: number) => (n > SHOWN ? [{ type: "text", text: `and ${n - SHOWN} more` }] : []);
  return {
    sections: [{
      id: "work",
      title: "Work",
      blocks: [
        { type: "stats", items: [
          { label: "in progress", value: String(inProgress.length) },
          { label: "ready", value: String(ready.length) },
          { label: "ready at p0–p1", value: String(urgent), ...(urgent ? { tone: "warn" } : {}) },
        ] },
        ...(inProgress.length
          ? [{ type: "list", items: items(inProgress, (e) => `in progress · p${e.priority ?? "?"}${e.assignee ? ` · ${e.assignee}` : ""}`) }, ...more(inProgress.length)]
          : []),
        ...(byPriority.length
          ? [{ type: "list", items: items(byPriority, (e) => `ready · p${e.priority ?? "?"}`) }, ...more(byPriority.length)]
          : [{ type: "text", text: "Nothing ready." }]),
      ],
    }],
  };
}
