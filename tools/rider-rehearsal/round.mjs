// Run one recorded rehearsal against the checked-out revision, after npm run build.
// PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alternateFlows, deviceOnly } from './flows.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const label = args.find((a) => !a.startsWith('--'));
if (!label || !/^[a-z0-9][a-z0-9_-]{0,60}$/i.test(label))
  throw new Error('Supply a rehearsal label, e.g. round-02-before');
if (!args.includes('--with-db'))
  throw new Error(
    'A full round requires --with-db and a disposable loopback MongoDB. For diagnostics, invoke an individual runner directly.'
  );
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8'
}).trim();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(root, 'private', 'rider-rehearsals', label + '-' + stamp);
await mkdir(dir, { recursive: true });
const cases = [
  ['phone', 'run.mjs', []],
  ['alternate-paths', 'controlled.mjs', ['--with-db']],
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
    const evidenceFile = path.join(dir, name + '.json');
    const child = spawn(
      process.execPath,
      [
        path.join(root, 'tools', 'rider-rehearsal', file),
        ...opts,
        '--evidence-file',
        evidenceFile
      ],
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
    let evidence;
    try {
      evidence = JSON.parse(await readFile(evidenceFile, 'utf8'));
    } catch {
      if (code === 0) throw new Error(name + ' emitted no structured evidence');
    }
    return { name, code, evidence };
  })
);
const automatedGatePassed = results.every(
  (r) => r.code === 0 && r.evidence?.status === 'passed'
);
const coverage = [];
const uncoveredAppFlows = [];
for (let n = 1; n <= 20; n++) {
  const id = 'UC' + String(n).padStart(2, '0');
  const mainId = id + '-M';
  const browserRuns = results.filter(
    (r) => r.name === 'phone' || r.name === 'desktop'
  );
  const primary = browserRuns.flatMap((r) =>
    (r.evidence?.flows ?? [])
      .filter((f) => f.flowId === mainId)
      .map((f) => ({ ...f, engine: r.evidence.engine }))
  );
  if (
    n < 20 &&
    !browserRuns.every((r) =>
      r.evidence?.flows?.some(
        (f) => f.flowId === mainId && f.status === 'passed'
      )
    )
  )
    uncoveredAppFlows.push(mainId);
  if (n === 20) primary.push(deviceOnly.find((f) => f.flowId === mainId));
  const controlled = results
    .find((r) => r.name === 'alternate-paths')
    ?.evidence?.useCases?.find((u) => u.id === id);
  const branches = (controlled?.flows ?? []).map((f) => ({
    ...f,
    status: 'assertions-passed',
    meaning:
      'Only the listed assertions are verified; review remaining prescribed substeps separately.'
  }));
  if (n === 20) {
    const operator = results.find((r) => r.name === 'operator')?.evidence;
    if (operator) branches.push(operator);
  }
  for (let index = 0; index < alternateFlows[id].length; index++) {
    const flowId = id + '-A' + (index + 1);
    if (!branches.some((f) => f.flowId === flowId))
      uncoveredAppFlows.push(flowId);
  }
  coverage.push({
    id,
    primary,
    branches,
    deviceOnly: deviceOnly.filter((f) => f.flowId.startsWith(id + '-'))
  });
}
const documented = new Set(
  [
    ...(
      await readFile(path.join(root, 'docs', 'FEATURES.md'), 'utf8')
    ).matchAll(/\bUC\d{2}-(?:M|A\d+)\b/g)
  ].map((m) => m[0])
);
const known = new Set(
  coverage.flatMap((c) => [...c.primary, ...c.branches].map((f) => f.flowId))
);
for (const id of documented) if (!known.has(id)) uncoveredAppFlows.push(id);
const accepted = automatedGatePassed && uncoveredAppFlows.length === 0;
await writeFile(
  path.join(dir, 'results.json'),
  JSON.stringify(
    {
      label,
      revision,
      localMapHash: mapHash,
      startedAt: stamp,
      status: accepted ? 'automated-gate-passed-device-pending' : 'failed',
      results: results.map(({ name, code }) => ({
        name,
        code,
        evidenceFile: name + '.json'
      })),
      coverage,
      uncoveredAppFlows,
      deviceOnly,
      coverageMeaning:
        'UC01–19 primary actions run in both requested browser engines against controlled service data. Alternate evidence is bounded by exact named assertions. UC20 installed-app launch and listed physical iPhone checks remain unexecuted; the operator dashboard is a separate actor.'
    },
    null,
    2
  )
);
console.log(
  JSON.stringify({
    label,
    revision,
    status: accepted ? 'automated-gate-passed-device-pending' : 'failed',
    useCases: coverage.length,
    uncoveredAppFlows,
    physicalChecksPending: deviceOnly.length,
    evidence: path.join(dir, 'results.json')
  })
);
if (!accepted) process.exitCode = 1;
