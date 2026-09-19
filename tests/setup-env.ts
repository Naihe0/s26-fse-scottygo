// Run before application imports/dotenv. Automated tests must never inherit
// a developer's Atlas database, production credentials, or email integration.
const testDatabase =
  process.env.TEST_DB_URL ?? 'mongodb://127.0.0.1:27019/scottygo_test';
const testURL = new URL(testDatabase);
if (
  testURL.protocol !== 'mongodb:' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(testURL.hostname) ||
  testURL.username ||
  testURL.password ||
  !/^\/scottygo_test(?:_[a-zA-Z0-9_-]+)?$/.test(testURL.pathname) ||
  testURL.search ||
  testURL.hash
) {
  throw new Error(
    'Tests require a loopback MongoDB URL with database scottygo_test or scottygo_test_*. Remote databases and credentials are refused.'
  );
}

process.env.TEST_DB_URL = testDatabase;
process.env.DB_URL = `${testURL.protocol}//${testURL.host}`;
process.env.DEV_DB = testURL.pathname;
process.env.PROD_DB = testURL.pathname;
process.env.STAGE = 'DEV';
process.env.ALLOW_DB_RESET = 'true';
process.env.ENV = 'LOCAL';
process.env.LOCAL_HOST = 'http://127.0.0.1';
process.env.BIND_ADDRESS = '127.0.0.1';
process.env.JWT_KEY = 'scottygo-automated-tests-only-not-a-production-secret';
process.env.INITIAL_ADMIN_PASSWORD = 'admin';
process.env.BREVO_API_KEY = '';
process.env.EMAIL_USER = '';
process.env.GEMINI_API_KEY = '';
process.env.GOOGLE_MAPS_KEY = '';
if (process.env.RUN_TRANSIT_E2E !== 'true') process.env.TRUETIME_KEY = '';

export {};
