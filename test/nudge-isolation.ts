// Process-level suites must never invoke a developer's installed loom for fixture writes.
// The notification suite supplies its own observing executables instead of this inert one.
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
const bin = mkdtempSync(join(tmpdir(), 'tasks-test-loom-'));
const loom = join(bin, 'loom');
writeFileSync(loom, `#!${process.execPath}\nprocess.exit(0);\n`);
chmodSync(loom, 0o755);
process.env.PATH = bin + delimiter + (process.env.PATH ?? '');
process.on('exit', () => rmSync(bin, { recursive: true, force: true }));
