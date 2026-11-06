// Run the deterministic alternate paths that a live transit feed cannot supply
// on demand. The browser walkthrough covers the normal interactive journeys.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = mkdtempSync(join(tmpdir(), 'scottygo-rider-'));
function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
const revision = git('rev-parse', 'HEAD');
const workingChanges = Boolean(git('status', '--porcelain', '--untracked-files=no'));
const suiteGroups = {
  UC01: ['auth-validation', 'register.unit'],
  UC02: ['auth-map-handoff', 'loginlogout.unit', 'auth-rate-limit.unit'],
  UC03: ['map-guide-flow', 'map-key', 'feedback'],
  UC04: ['map-location-recovery', 'location-search-recovery', 'geolocation-controller'],
  UC05: ['map-filter-controls', 'route-control-interactions', 'transit-startup-recovery', 'map-appearance', 'map-appearance-panel', 'google-map-provider'],
  UC06: ['map-hit-test', 'map-selection-provider', 'map-selection', 'route-renderer'],
  UC07: ['transit-search'],
  UC08: ['nearby-stops-panel', 'nearby-stop-actions'],
  UC09: ['route-explorer'],
  UC10: ['prediction-requests', 'prediction-shortcuts', 'stop-boarding', 'arrival-identity'],
  UC11: ['vehicle-motion-replay', 'vehicle-motion-tracker', 'vehicle-tracker'],
  UC12: ['directions-controller', 'walking-directions.service', 'directions-restoration'],
  UC13: ['rider-shortcuts', 'rider-shortcuts-store'],
  UC14: ['copy-view-link', 'stop-link-navigation', 'map-auth-return'],
  UC15: ['subscriptions', 'map-subscription-session'],
  UC16: ['notification-rendering', 'notification-inbox', 'agency-window', 'alert-metadata.unit'],
  UC17: ['live-notification-stack', 'live-notification-lifecycle'],
  UC18: ['frontend-accessibility', 'live-notification.unit'],
  UC19: ['manageacct.unit'],
  UC20: ['transit-feed-lifecycle.unit']
};

// Mongo integration suites use fixed loopback ports. Run serially with no
// other integration/REST tests on this host. The default needs no database.
if (process.argv.includes('--with-db')) {
  Object.entries({
    UC01: 'register', UC02: 'loginlogout', UC15: 'subscription-concurrency',
    UC18: 'livenotification', UC19: 'manageacct'
  }).forEach(([id, name]) => suiteGroups[id].push(name + '.integration'));
}

function testPath(name) {
  const folder = name.endsWith('.unit') ? 'server.tests/unit.tests' :
    name.endsWith('.integration') ? 'server.tests/integration.tests' : 'client.tests';
  return join(root, 'tests', folder, name + '.test.ts');
}

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', maxBuffer: 25 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write((result.stderr || result.stdout).slice(-16000));
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

const resultPath = join(evidence, 'jest.json');
const names = new Set(Object.values(suiteGroups).flat());
run([
  join(root, 'node_modules/jest/bin/jest.js'), '--runInBand', '--coverage=false',
  '--json', '--outputFile', resultPath, '--runTestsByPath', ...Array.from(names, testPath)
]);
const result = JSON.parse(readFileSync(resultPath, 'utf8'));
const passed = new Set(result.testResults.filter(s => s.status === 'passed').map(s => s.name));
for (const [id, suites] of Object.entries(suiteGroups)) {
  if (!suites.every(name => passed.has(testPath(name)))) {
    throw new Error(id + ' missing a passing suite; see ' + resultPath);
  }
}

const native = run(['--test', 'tests/navigation.test.mjs', 'tests/content-recovery.test.mjs'],
  join(root, 'ios/mobile'));
const nativePassed = Number(native.match(/^.*pass (\d+)$/m)?.[1]);
if (!nativePassed) throw new Error('iOS host checks returned no passing tests');

console.log(JSON.stringify({
  revision, workingChanges,
  evidence: resultPath,
  useCases: Object.keys(suiteGroups),
  suites: result.numPassedTestSuites,
  assertions: result.numPassedTests,
  nativeHostTests: nativePassed,
  mongoIntegration: process.argv.includes('--with-db')
}));
