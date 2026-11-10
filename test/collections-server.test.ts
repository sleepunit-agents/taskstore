import { it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../src/sqlite-store.js';

it('reuses one process, reads external writes immediately, and keeps viewer/query state per request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-query-server-'));
  const env = { ...process.env, TASKSTORE_DB: join(dir, 'store.db') };
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  const args = ['--import', 'tsx', cli, 'collections', 'query', '--json'];
  const batch = { viewer: { kind: 'member', household: true }, queries: [{ id: 'q', type: 'task', version: 1, where: [], order: [], limit: 500, after: null, fields: ['title'] }] };
  const store = new SqliteStore(env.TASKSTORE_DB);
  store.run({ op: 'create', title: 'First', actor: 'art', at: new Date().toISOString() });
  store.close();
  const before = performance.now();
  for (let i = 0; i < 10; i++) {
    const one = spawnSync(process.execPath, args, { env, input: JSON.stringify(batch), encoding: 'utf8' });
    expect(one.status).toBe(0);
    expect(one.stdout).toContain('First');
  }
  const beforeMs = performance.now() - before;
  const after = performance.now();
  const child = spawn(process.execPath, [...args, '--serve'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const ask = async (request: unknown) => {
    const n = ++id;
    child.stdin.write(JSON.stringify({ id: n, grant: n % 2 ? 'per-call-only' : null, request }) + '\n');
    const result = await lines.next();
    expect(result.done).toBe(false);
    const answer = JSON.parse(result.value!);
    expect(answer.id).toBe(n);
    return answer;
  };
  try {
    for (let i = 0; i < 10; i++) expect((await ask(batch)).stdout).toContain('First');
    const afterMs = performance.now() - after;
    console.log(`10 queries: before ${Math.round(beforeMs)}ms / 10 processes; after ${Math.round(afterMs)}ms / 1 process`);
    const write = spawnSync(process.execPath, ['--import', 'tsx', cli, 'create', 'Second'], { env, encoding: 'utf8' });
    expect(write.status).toBe(0);
    expect((await ask(batch)).stdout).toContain('Second');
    expect((await ask({ ...batch, viewer: { kind: 'agent', agent: 'art' } })).stdout).not.toContain('First');
    expect((await ask(null)).exit).toBe(1);
    expect((await ask({ ...batch, queries: [{ ...batch.queries[0], fields: [], limit: 1 }] })).stdout).not.toContain('First');
    expect((await ask(batch)).stdout).toContain('First');
  } finally { child.kill(); rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
