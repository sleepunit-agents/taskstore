// Counts lost writes under concurrent writers, outside vitest (t-1831):
//   npx tsx scripts/concurrent-bench.ts <writers> <opsPerWriter> store|cli
// Needs dist built (npm run build). The conformance fixture runs the same
// harness at 8 x 100 in store mode.
import { runConcurrentWriters } from "../test/concurrency.js";
const [w = "8", n = "100", mode = "store"] = process.argv.slice(2);
const t0 = Date.now();
const r = await runConcurrentWriters({ writers: Number(w), opsPerWriter: Number(n), sharedTasks: 4 }, mode as "store" | "cli");
console.log(JSON.stringify({ ...r, lost: r.lost.length, lostSample: r.lost.slice(0, 5), ms: Date.now() - t0 }));
