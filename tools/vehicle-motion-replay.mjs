/* Run: node tools/vehicle-motion-replay.mjs [--baseline 17a0421] */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const path = require('node:path');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const {
  VehicleMotionEstimator
} = require('../client/scripts/services/vehicle-motion');
const {
  motionReplayScenarios,
  runMotionReplay
} = require('./vehicle-motion-replay-fixtures');

function baselineEstimator(ref) {
  if (!/^[A-Za-z0-9_./-]+$/.test(ref) || ref.startsWith('-'))
    throw new Error('Invalid baseline git reference');
  const source = execFileSync(
    'git',
    ['show', `${ref}:client/scripts/services/vehicle-motion.ts`],
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024
    }
  );
  const filename = path.resolve(
    __dirname,
    '../client/scripts/services/vehicle-motion-baseline.ts'
  );
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2021
      }
    }).outputText,
    filename
  );
  return compiled.exports.VehicleMotionEstimator;
}

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--baseline'))
  throw new Error(
    'Usage: node tools/vehicle-motion-replay.mjs [--baseline <git-ref>]'
  );
const baseline = args.length ? baselineEstimator(args[1]) : null;
const scenarios = motionReplayScenarios();

function computeBenchmark(Estimator) {
  const vehicles = 200;
  const sampleHz = 20;
  const simulatedSeconds = 30;
  const epoch = Date.parse('2026-10-24T12:00:00Z');
  const lat = 40.44;
  const lng = -79.94;
  const longitudeScale = 111_194.9266 * Math.cos((lat * Math.PI) / 180);
  const elapsedRuns = [];
  let worstFrameMs = 0;
  for (let run = 0; run < 3; run++) {
    const estimator = new Estimator();
    estimator.setRouteGeometry(
      'R',
      [
        {
          shapeId: 'main',
          direction: 'OUTBOUND',
          path: Array.from({ length: 91 }, (_, i) => ({
            lat,
            lng: lng + (i * 50) / longitudeScale
          }))
        }
      ],
      []
    );
    const ingest = (second) => {
      for (let i = 0; i < vehicles; i++)
        estimator.ingest(
          {
            vid: `bus-${i}`,
            routeId: 'R',
            shapeId: 'main',
            tripId: 'trip',
            direction: 'OUTBOUND',
            source: 'live',
            isDetoured: false,
            lat,
            lon: lng + (100 + i * 8 + second * 8) / longitudeScale,
            heading: 90,
            speed: 8,
            lastUpdate: new Date(epoch + second * 1000).toISOString()
          },
          epoch + second * 1000
        );
    };
    ingest(0);
    ingest(10);
    const start = performance.now();
    for (let frame = 0; frame < simulatedSeconds * sampleHz; frame++) {
      const frameStart = performance.now();
      const second = 10 + frame / sampleHz;
      if (frame > 0 && frame % (10 * sampleHz) === 0) ingest(second);
      for (let i = 0; i < vehicles; i++)
        estimator.estimate(`bus-${i}`, epoch + second * 1000);
      worstFrameMs = Math.max(worstFrameMs, performance.now() - frameStart);
    }
    elapsedRuns.push(performance.now() - start);
  }
  const median = elapsedRuns.sort((a, b) => a - b)[1];
  return {
    vehicles,
    sampleHz,
    simulatedSeconds,
    estimateCallsPerRun: vehicles * sampleHz * simulatedSeconds,
    medianElapsedMs: Math.round(median * 100) / 100,
    meanFrameComputeMs:
      Math.round((median / (sampleHz * simulatedSeconds)) * 1000) / 1000,
    worstFrameComputeMs: Math.round(worstFrameMs * 1000) / 1000,
    note: 'Local Node.js CPU-only measurement, median of three runs; includes 10-second ingest cycles, excludes Google Maps rendering and network.'
  };
}

console.log(
  JSON.stringify(
    {
      kind: 'synthetic-replay',
      note: 'Controlled trajectories expose regressions. These errors are not measured real-world bus-location accuracy; outages and first-fix delay are intentionally difficult.',
      sampleHz: 20,
      baselineRef: baseline ? args[1] : null,
      compute: {
        ...(baseline ? { baseline: computeBenchmark(baseline) } : {}),
        current: computeBenchmark(VehicleMotionEstimator)
      },
      scenarios: scenarios.map((scenario) => ({
        name: scenario.name,
        description: scenario.description,
        ...(baseline
          ? { baseline: runMotionReplay(() => new baseline(), scenario) }
          : {}),
        current: runMotionReplay(() => new VehicleMotionEstimator(), scenario)
      }))
    },
    null,
    2
  )
);
