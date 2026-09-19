#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
// Preserve the selected Node runtime; npm.cmd cannot be spawned without a shell.
const npm =
  process.env.npm_execpath ||
  join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (!existsSync(npm)) {
  console.error('Run this check with npm run prepush:check.');
  process.exit(1);
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// No formatter rewrites or destructive database suites.
run('git', ['diff', '--check', 'HEAD']);
for (const task of ['check:paths', 'lint', 'typecheck', 'build', 'test:unit']) {
  console.log(`\nChecking ${task}...`);
  run(process.execPath, [npm, 'run', task]);
}
console.log(
  '\nPre-push checks passed. CI also runs isolated MongoDB integration and REST tests.'
);
