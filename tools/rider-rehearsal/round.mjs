// Run one recorded rehearsal against the checked-out revision, after npm run build.
// PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const label = args.find((a) => !a.startsWith('--'));
if (!label || !/^[a-z0-9][a-z0-9_-]{0,60}$/i.test(label))
  throw new Error('Supply a rehearsal label, e.g. round-02-before');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8'
}).trim();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(root, 'private', 'rider-rehearsals', label + '-' + stamp);
await mkdir(dir, { recursive: true });
const cases = [
  ['phone', 'run.mjs', []],
  [
    'alternate-paths',
    'controlled.mjs',
    args.includes('--with-db') ? ['--with-db'] : []
  ],
  ['operator', 'dashboard.mjs', []]
];
if (args.includes('--desktop'))
  cases.push(['desktop', 'run.mjs', ['--desktop']]);
if (args.includes('--published'))
  for (const [, file, opts] of cases)
    if (file === 'run.mjs') opts.push('--production-assets');
const map = await readFile(path.join(root, '.dist', 'client', 'map.html'));
const mapHash = createHash('sha256').update(map).digest('hex');
const results = await Promise.all(
  cases.map(async ([name, file, opts]) => {
    const child = spawn(
      process.execPath,
      [path.join(root, 'tools', 'rider-rehearsal', file), ...opts],
      { cwd: root, windowsHide: true }
    );
    let log = '';
    child.stdout.on('data', (d) => {
      log += d;
    });
    child.stderr.on('data', (d) => {
      log += d;
    });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    await writeFile(path.join(dir, name + '.log'), log);
    console.log(
      name,
      code === 0 ? 'passed' : 'FAILED',
      log.trim().split(/\r?\n/).at(-1)?.slice(0, 350)
    );
    return { name, code };
  })
);
await writeFile(
  path.join(dir, 'results.json'),
  JSON.stringify(
    { label, revision, localMapHash: mapHash, startedAt: stamp, results },
    null,
    2
  )
);
if (results.some((r) => r.code !== 0)) process.exitCode = 1;
