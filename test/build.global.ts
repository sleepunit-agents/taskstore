// Build dist once, before any test file runs. The suites that drive the CLI
// as a process (cli-binding, bundle, loom-ui, project-feed, plain) used to
// each rebuild it in their own beforeAll; vitest runs files in parallel, so
// one file's tsc rewrote dist/*.js while another's CLI was importing them
// (CI on #32: "./core.js does not provide an export named 'apply'").
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default function setup(): void {
  execFileSync("npm", ["run", "build"], { cwd: join(__dirname, ".."), stdio: "pipe" });
}
