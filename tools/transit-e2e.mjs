import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const result = spawnSync(
  process.execPath,
  [
    require.resolve('jest/bin/jest'),
    'tests/server.tests/rest.tests/transitAPI.rest.test.ts',
    '--runInBand',
    '--detectOpenHandles',
    '--coverageDirectory=.coverage/rest-transitAPI'
  ],
  { stdio: 'inherit', env: { ...process.env, RUN_TRANSIT_E2E: 'true' } }
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
