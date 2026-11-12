import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStore } from '../src/sqlite-store.js';
import { describe, expect, it } from 'vitest';

const cli = join(__dirname, '../dist/cli.js');
function fixture(mode: 'ok' | 'missing' | 'fail' | 'hang' = 'ok') {
  const dir = mkdtempSync(join(tmpdir(), 'taskstore-nudge-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const calls = join(dir, 'calls');
  const snapshots = join(dir, 'snapshots');
  const dbPath = join(dir, 'store.db');
  if (mode !== 'missing') {
    const stub = join(bin, 'loom');
    writeFileSync(stub, `#!${process.execPath}\n` +
      `require('node:fs').appendFileSync(process.env.NUDGE_CALLS, JSON.stringify(process.argv.slice(2))+'\\n');\n` +
      `const db = require(${JSON.stringify(join(__dirname, '../node_modules/better-sqlite3'))})(process.env.TASKSTORE_DB); require('node:fs').appendFileSync(process.env.NUDGE_SNAPSHOTS, JSON.stringify({ tasks: db.prepare('SELECT record FROM tasks').all().map(r=>JSON.parse(r.record)), changes: db.prepare('SELECT count(*) AS n FROM collection_changes').get().n })+'\\n'); db.close();\n` +
      (mode === 'hang' ? 'setInterval(()=>{},1000);' : `process.exit(${mode === 'fail' ? 1 : 0});`));
    chmodSync(stub, 0o755);
  }
  const invoke = (args: string[], input?: string) => {
    const r = spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, PATH: bin, TASKSTORE_DB: dbPath,
        LOOM_BODY_CONVERSATION: '', TASKSTORE_OWNER: 'jonathan', NUDGE_CALLS: calls, NUDGE_SNAPSHOTS: snapshots },
      encoding: 'utf8', timeout: 10000, input,
    });
    expect(r.error).toBeUndefined();
    return { code: r.status, result: JSON.parse(r.stdout), stderr: r.stderr };
  };
  const hints = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(x => JSON.parse(x)) : [];
  const run = (...args: string[]) => invoke(args);
  const act = (body: unknown) => invoke(['ui', 'act', '--json'], JSON.stringify(body));
  const committed = () => existsSync(snapshots) ? readFileSync(snapshots, 'utf8').trim().split('\n').map(x => JSON.parse(x)) : [];
  return { run, hints, act, committed, dbPath };
}

describe('CLI collection hints', () => {
  it('announces committed writes, including import and deletion, using only the public domain', () => {
    const { run, hints, committed } = fixture();
    const write = (...args: string[]) => {
      const n = hints().length;
      expect(run(...args).code).toBe(0);
      expect(hints().length).toBe(n + 1);
      expect(hints().at(-1)).toEqual(['collections', 'nudge', 'tasks/task']);
    };
    write('create', 'First task', '--spec-item-ref', 'first');
    expect(committed()[0]).toMatchObject({ tasks: [{ title: 'First task' }], changes: 1 });
    write('create', 'Second task');
    write('update', 't-1', '--description', 'New searchable text');
    expect(committed().at(-1).tasks[0].description).toBe('New searchable text');
    write('claim', 't-1');
    write('unclaim', 't-1');
    write('update', 't-1', '--priority', '1');
    write('comment', 't-1', 'A comment');
    write('link', 't-1', 't-2', '--type', 'blocks');
    write('unlink', 't-1', 't-2', '--type', 'blocks');
    write('close', 't-1');
    write('reopen', 't-1');
    const file = join(mkdtempSync(join(tmpdir(), 'taskstore-import-')), 'tasks.json');
    writeFileSync(file, JSON.stringify({ tasks: run('export').result.tasks.filter((t: { id: string }) => t.id === 't-2'), links: [] }));
    write('delete', 't-2');
    write('import', file);
  });

  it('keeps reads, rejected writes and collection no-ops silent', () => {
    const { run, hints } = fixture();
    expect(run('create', 'First task', '--spec-item-ref', 'first').code).toBe(0);
    expect(run('create', 'Second task').code).toBe(0);
    expect(run('link', 't-1', 't-2', '--type', 'blocks').code).toBe(0);
    const n = hints().length;
    for (const args of [
      ['show', 't-1'], ['list'], ['search', 'First'], ['report'], ['ready'], ['export'],
      ['create', 'First task', '--spec-item-ref', 'first'],
      ['link', 't-1', 't-2', '--type', 'blocks'],
      ['unlink', 't-2', 't-1', '--type', 'blocks'],
      ['update', 't-1', '--priority', '2'],
      ['update', 't-1'], ['claim', 't-missing'],
      ['update', 't-1', '--assignee', 'jonathan'],
    ]) {
      run(...args);
      expect(hints().length).toBe(n);
    }
  });

  it('announces UI actions, retaining a committed hint across follow-up reads and no-ops', () => {
    const { act, hints, committed, dbPath } = fixture();
    new SqliteStore(dbPath).close();
    expect(act({ action: 'create', path: 'new', fields: { title: 'Page task', priority: '1', mine: '1' } }).result.ok).toBe(true);
    expect(hints()).toHaveLength(1);
    expect(committed()[0].tasks[0]).toMatchObject({ title: 'Page task', assignee: 'jonathan' });
    for (const body of [
      { action: 'comment', fields: { id: 't-1', text: 'Read after write' } },
      { action: 'priority', fields: { id: 't-1', priority: '0' } },
      { action: 'close', fields: { id: 't-1' } },
      { action: 'reopen', fields: { id: 't-1' } },
    ]) { const n = hints().length; expect(act(body).result.ok).toBe(true); expect(hints()).toHaveLength(n + 1); }
    const n = hints().length;
    expect(act({ action: 'priority', fields: { id: 't-1', priority: '0' } }).result.ok).toBe(true);
    expect(hints()).toHaveLength(n);
  });

  it('does not hint when a failure after logging rolls the transaction back', () => {
    const { run, hints, dbPath } = fixture();
    run('create', 'Before rollback');
    const db = new Database(dbPath);
    // Mirror rename is after collection logging, inside the write transaction.
    const log = dbPath.replace(/\.db$/, '') + '.interactions.jsonl';
    const beforeInteractions = readFileSync(log, 'utf8');
    const beforeChanges = db.prepare('SELECT * FROM collection_changes').all();
    const mirror = dbPath.replace(/\.db$/, '') + '.export.jsonl';
    renameSync(mirror, mirror + '.saved'); mkdirSync(mirror);
    const n = hints().length;

    expect(run('update', 't-1', '--title', 'Rolled back').code).toBe(1);
    expect(hints()).toHaveLength(n);
    expect(run('show', 't-1').result.task.title).toBe('Before rollback');
    expect(db.prepare('SELECT * FROM collection_changes').all()).toEqual(beforeChanges);
    expect(readFileSync(log, 'utf8')).toBe(beforeInteractions);
    db.close();
  });

  for (const mode of ['missing', 'fail', 'hang'] as const) {
    it(`preserves mutation success when loom is ${mode}`, () => {
      const { run, hints, committed } = fixture(mode);
      const start = performance.now();
      const written = run('create', 'Saved even without loom');
      expect(performance.now() - start).toBeLessThan(3500);
      expect(hints().length).toBe(mode === 'missing' ? 0 : 1);
      expect(written.code).toBe(0);
      expect(written.result.ok).toBe(true);
      expect(written.stderr).not.toContain('nudge');
      const saved = run('show', written.result.id).result.task;
      expect(saved.title).toBe('Saved even without loom');
      if (mode !== 'missing') expect(saved).toEqual({ ...committed()[0].tasks[0], dependsOn: [] });
      const baseline = fixture().run('create', 'Saved even without loom');
      expect(written).toEqual(baseline);
    });
  }
});
