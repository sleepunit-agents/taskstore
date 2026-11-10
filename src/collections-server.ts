/** One process, fresh store snapshot per query. No answer cache, viewer state, or per-call grant in process.env. */
import { createInterface } from 'node:readline';
import { existsSync, statSync } from 'node:fs';
import { SqliteStore } from './sqlite-store.js';
import { answer, type Batch } from './collections.js';
import type { Task, Link } from './core.js';

export function queryCollection(dbPath: string, owner: string, batch: Batch): string {
  if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
    return (batch.queries ?? []).map((q) => JSON.stringify({ id: q.id, error: 'unavailable' })).join('\n') + '\n';
  }
  // Open afresh: a replaced database, a CLI mutation, or another process's write is seen on the very next request.
  const store = new SqliteStore(dbPath);
  try {
    const all = store.run({ op: 'export' }) as { tasks?: Task[]; links?: Link[] };
    return answer(batch, all.tasks ?? [], all.links ?? [], owner).join('\n') + '\n';
  } finally { store.close(); }
}

export async function serveCollections(dbPath: string, owner: string): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line) > 128 * 1024) throw new Error('collection request too large');
    let id: unknown = null;
    let stdout = '', exit = 1;
    try {
      const call = JSON.parse(line) as { id: unknown; request: Batch };
      id = call.id;
      // Core already checks grants, declaration and query for this viewer. This read-only provider uses only the
      // viewer in this request; the per-call store grant is deliberately never kept or installed in the environment.
      stdout = queryCollection(dbPath, owner, call.request);
      exit = 0;
    } catch { /* one failed request cannot return a previous viewer's answer */ }
    const out = JSON.stringify({ id, exit, stdout }) + '\n';
    await new Promise<void>((resolve, reject) => process.stdout.write(out, (e) => e ? reject(e) : resolve()));
  }
}
