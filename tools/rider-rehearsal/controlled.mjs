// Run the deterministic alternate paths that a live transit feed cannot supply
// on demand. The browser walkthrough covers the normal interactive journeys.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  mkdirSync,
  openSync,
  writeFileSync,
  closeSync,
  unlinkSync
} from 'node:fs';
import { suiteGroups, alternateFlows, deviceOnly } from './flows.mjs';
import { recordEvidence } from './evidence.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = mkdtempSync(join(tmpdir(), 'scottygo-rider-'));
function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
const revision = git('rev-parse', 'HEAD');
const workingChanges = Boolean(
  git('status', '--porcelain', '--untracked-files=no')
);
// Mongo integration suites use fixed loopback ports. Run serially with no
// other integration/REST tests on this host. The default needs no database.
if (process.argv.includes('--with-db')) {
  Object.entries({
    UC01: 'register',
    UC02: 'loginlogout',
    UC15: 'subscription-concurrency',
    UC18: 'livenotification',
    UC19: 'manageacct'
  }).forEach(([id, name]) => suiteGroups[id].push(name + '.integration'));
}

function testPath(name) {
  const folder = name.endsWith('.unit')
    ? 'server.tests/unit.tests'
    : name.endsWith('.integration')
      ? 'server.tests/integration.tests'
      : 'client.tests';
  return join(root, 'tests', folder, name + '.test.ts');
}

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 25 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write((result.stderr || result.stdout).slice(-16000));
    throw new Error(
      'Controlled test process failed with status ' + result.status
    );
  }
  return result.stdout;
}

const withDb = process.argv.includes('--with-db');
const lockPath = join(root, 'tmp', 'rider-rehearsal-db.lock');
let lock;
if (withDb) {
  mkdirSync(join(root, 'tmp'), { recursive: true });
  try {
    lock = openSync(lockPath, 'wx');
  } catch {
    throw new Error(
      'A database rehearsal already owns ' +
        lockPath +
        '. Wait for it to finish; do not run shared DB suites concurrently.'
    );
  }
  writeFileSync(
    lock,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      revision
    })
  );
}
try {
  const resultPath = join(evidence, 'jest.json');
  const names = new Set(Object.values(suiteGroups).flat());
  run([
    join(root, 'node_modules/jest/bin/jest.js'),
    '--runInBand',
    '--coverage=false',
    '--json',
    '--outputFile',
    resultPath,
    '--runTestsByPath',
    ...Array.from(names, testPath)
  ]);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  const passed = new Set(
    result.testResults.filter((s) => s.status === 'passed').map((s) => s.name)
  );
  const useCases = Object.entries(suiteGroups).map(([id, suites]) => {
    if (!suites.every((name) => passed.has(testPath(name))))
      throw new Error(id + ' missing a passing suite; see ' + resultPath);
    const assertions = result.testResults
      .filter((s) => suites.some((name) => testPath(name) === s.name))
      .flatMap((s) =>
        s.assertionResults.map((a) => ({
          title: a.fullName,
          testName: a.title,
          file: s.name.slice(root.length).replaceAll('\\', '/'),
          status: a.status
        }))
      );
    const flows = alternateFlows[id].flatMap(([behavior, pattern], index) => {
      if (!pattern) return [];
      const matched = assertions.filter((a) =>
        new RegExp(pattern, 'i').test(a.testName)
      );
      if (!matched.some((a) => a.status === 'passed'))
        throw new Error(
          id + '-A' + (index + 1) + ' has no matching passing assertion'
        );
      return [
        {
          flowId: id + '-A' + (index + 1),
          behavior,
          coverage: 'assertion-bounded',
          method: 'controlled-unit-or-integration',
          assertions: matched
        }
      ];
    });
    return {
      id,
      suites: suites.map(testPath),
      flows,
      assertionCount: assertions.length
    };
  });

  const native = run(
    [
      '--test',
      '--test-reporter=tap',
      'tests/navigation.test.mjs',
      'tests/content-recovery.test.mjs'
    ],
    join(root, 'ios/mobile')
  );
  const nativePassed = Number(native.match(/^.*pass (\d+)$/m)?.[1]);
  if (!nativePassed)
    throw new Error('iOS host checks returned no passing tests');
  const nativeAssertions = [...native.matchAll(/^# Subtest: (.+)$/gm)].map(
    (m) => m[1]
  );
  useCases
    .find((c) => c.id === 'UC20')
    .flows.push({
      flowId: 'UC20-A1',
      coverage: 'host-logic-only',
      method: 'node-native-host-modules',
      assertions: nativeAssertions
    });
  await recordEvidence({
    status: 'passed',
    revision,
    workingChanges,
    evidence: resultPath,
    useCases,
    suites: result.numPassedTestSuites,
    assertions: result.numPassedTests,
    nativeHostTests: nativePassed,
    mongoIntegration: withDb,
    deviceOnly,
    scope:
      'Each branch lists exact matched assertions. These assertions do not prove every substep or real iPhone OS behavior.'
  });
} finally {
  if (lock !== undefined) {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
