import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = join(__dirname, '../dist/cli.js');
function fixture(mode = 'ok') {
  const dir = mkdtempSync(join(tmpdir(), 'taskstore-nudge-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const calls = join(dir, 'calls');
  if (mode !== 'missing') {
    const stub = join(bin, 'loom');
    writeFileSync(stub, `#!${process.execPath}\n` +
      `require('node:fs').appendFileSync(process.env.NUDGE_CALLS, JSON.stringify(process.argv.slice(2))+'\\n');\n` +
      (mode === 'hang' ? 'setInterval(()=>{},1000);' : `process.exit(${mode === 'fail' ? 1 : 0});`));
    chmodSync(stub, 0o755);
  }
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, PATH: bin, TASKSTORE_DB: join(dir, 'store.db'),
        LOOM_BODY_CONVERSATION: '', TASKSTORE_OWNER: 'jonathan', NUDGE_CALLS: calls },
      encoding: 'utf8', timeout: 10000,
    });
    expect(r.error).toBeUndefined();
    return { code: r.status, result: JSON.parse(r.stdout), stderr: r.stderr };
  };
  const hints = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(x => JSON.parse(x)) : [];
  return { run, hints };
}

describe('CLI collection hints', () => {
  it('announces committed writes, including import and deletion, using only the public domain', () => {
    const { run, hints } = fixture();
    const write = (...args: string[]) => {
      const n = hints().length;
      expect(run(...args).code).toBe(0);
      expect(hints().length).toBe(n + 1);
      expect(hints().at(-1)).toEqual(['collections', 'nudge', 'tasks/task']);
    };
    write('create', 'First task', '--spec-item-ref', 'first');
    write('create', 'Second task');
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
      ['update', 't-1'], ['claim', 't-missing'],
      ['update', 't-1', '--assignee', 'jonathan'],
    ]) {
      run(...args);
      expect(hints().length).toBe(n);
    }
  });

  for (const mode of ['missing', 'fail', 'hang']) {
    it(`preserves mutation success when loom is ${mode}`, () => {
      const { run } = fixture(mode);
      const written = run('create', 'Saved even without loom');
      expect(written.code).toBe(0);
      expect(written.result.ok).toBe(true);
      expect(written.stderr).not.toContain('nudge');
      expect(run('show', written.result.id).result.task.title).toBe('Saved even without loom');
    });
  }
});
