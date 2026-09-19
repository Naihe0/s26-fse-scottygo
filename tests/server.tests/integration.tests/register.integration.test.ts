/**
 * Integration tests for Register use case
 * Tests the full REST API stack: HTTP request → Express → Controller → Model → MongoDB
 *
 * Uses a real test database (scottygo_test_register_int) that is
 * cleared and re-seeded on every run via initOnStart: true.
 */

import { Server as HttpServer } from 'http';
import App from '../../../server/app';
import { MongoDB } from '../../../server/db/mongo.db';
import AuthController from '../../../server/controllers/auth.controller';
import MapController from '../../../server/controllers/map.controller';
import DAC from '../../../server/db/dac';
import { IUser } from '../../../common/user.interface';
import * as responses from '../../../common/server.responses';

// Mock external services that are irrelevant to registration
jest.mock('../../../server/services/email.service', () => ({
  __esModule: true,
  default: {
    sendAccountInactivatedEmail: jest.fn().mockResolvedValue(true),
    sendAccountReactivatedEmail: jest.fn().mockResolvedValue(true)
  }
}));

jest.mock('../../../server/services/gtfs.service', () => ({
  __esModule: true,
  default: {
    load: jest.fn().mockResolvedValue(undefined),
    isLoaded: jest.fn().mockReturnValue(true)
  }
}));

jest.mock('../../../server/models/transit.model', () => ({
  __esModule: true,
  TransitModel: {
    refreshAllCaches: jest.fn().mockResolvedValue(undefined)
  }
}));

jest.mock('../../../server/services/vehicle-positions.service', () => ({
  __esModule: true,
  default: { start: jest.fn(), stop: jest.fn() }
}));

jest.mock('../../../server/services/trip-updates.service', () => ({
  __esModule: true,
  default: { start: jest.fn(), stop: jest.fn() }
}));

jest.mock('../../../server/services/memory-monitor.service', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    stop: jest.fn(),
    capture: jest.fn(),
    enablePersistence: jest.fn()
  }
}));

jest.mock('../../../server/services/alerts.service', () => ({
  __esModule: true,
  default: { start: jest.fn(), stop: jest.fn(), onAlertsChanged: null }
}));

// ============================================================================
// Test configuration
// ============================================================================

const TEST_PORT = 8185;
const TEST_URL = `http://localhost:${TEST_PORT}`;
const TEST_DB_URL =
  process.env.TEST_DB_URL ??
  (process.env.DB_URL && process.env.DEV_DB
    ? `${process.env.DB_URL}${process.env.DEV_DB}`
    : 'mongodb://127.0.0.1:27017/scottygo_test_register_int');

// Global state
let app: App;
let server: HttpServer;

// ============================================================================
// Helpers
// ============================================================================

async function request(
  method: string,
  path: string,
  body?: object
): Promise<{ status: number; data: responses.IResponse }> {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  const response = await fetch(`${TEST_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  return { status: response.status, data };
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeAll(async () => {
  const db = new MongoDB(TEST_DB_URL);
  app = new App(
    [MapController.getInstance('/'), AuthController.getInstance('/auth')],
    {
      clientDir: './.dist/client',
      db,
      port: TEST_PORT,
      host: 'localhost',
      url: TEST_URL,
      initOnStart: true
    }
  );

  server = await app.listen();
  await new Promise((resolve) => setTimeout(resolve, 1000));
}, 30000);

afterAll(async () => {
  if (app && app.io) {
    await new Promise<void>((resolve) => app.io.close(() => resolve()));
  }
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (DAC.db) await DAC.db.close();
}, 10000);

// ============================================================================
// Integration Tests
// ============================================================================

describe('Register Integration Tests', () => {
  // --------------------------------------------------------------------------
  // 1. STATE-UPDATING, POSITIVE: Successful registration persists new user
  // --------------------------------------------------------------------------
  test('new user registered with valid data and login confirms the new account', async () => {
    const newUser = {
      credentials: { username: 'regtest1', password: 'Pass1!' },
      email: 'regtest1@andrew.cmu.edu',
      agreed: true
    };

    // Act: register the user
    const regRes = await request('POST', '/auth/users', newUser);

    // Assert: 201 with UserRegistered
    expect(regRes.status).toBe(201);
    const regSuccess = regRes.data as responses.ISuccess;
    expect(regSuccess.name).toBe('UserRegistered');
    const payload = regSuccess.payload as IUser;
    expect(payload.credentials.username).toBe('regtest1');
    expect(payload.credentials.password).toBe('obfuscated');
    expect(payload.email).toBe('regtest1@andrew.cmu.edu');
    expect(payload.agreed).toBe(true);
    expect(payload._id).toBeDefined();

    // Verify state: login succeeds, confirming the user was persisted
    const loginRes = await request(
      'POST',
      `/auth/tokens/${newUser.credentials.username}`,
      { password: newUser.credentials.password }
    );
    expect(loginRes.status).toBe(200);
    const loginSuccess = loginRes.data as responses.ISuccess;
    expect(loginSuccess.name).toBe('UserAuthenticated');
    const authPayload = loginSuccess.payload as responses.IAuthenticatedUser;
    expect(authPayload.user.credentials.username).toBe('regtest1');
    expect(authPayload.user.email).toBe('regtest1@andrew.cmu.edu');
    expect(authPayload.token).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // 2. STATE-UPDATING, NEGATIVE: Duplicate credentials yield UserExists and
  //    original user is unchanged
  // --------------------------------------------------------------------------
  test('(negative) registering with same credentials as existing user returns UserExists and original account unchanged', async () => {
    // Setup: register a user first
    const existingUser = {
      credentials: { username: 'dupuser', password: 'Dup1$' },
      email: 'dupuser@cmu.edu',
      agreed: true
    };
    const setupRes = await request('POST', '/auth/users', existingUser);
    expect(setupRes.status).toBe(201);

    // Act: try to register again with same credentials
    const dupRes = await request('POST', '/auth/users', {
      credentials: existingUser.credentials,
      email: 'different@andrew.cmu.edu',
      agreed: false
    });

    // Assert: 400 with UserExists
    expect(dupRes.status).toBe(400);
    const error = dupRes.data as responses.IAppError;
    expect(error.type).toBe('ClientError');
    expect(error.name).toBe('UserExists');

    // Verify state: the original user is unchanged in the database
    const dbUser = await DAC.db.findUserByUsername('dupuser');
    expect(dbUser).not.toBeNull();
    expect(dbUser!.email).toBe('dupuser@cmu.edu');
    expect(dbUser!.agreed).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 3. QUERY, NEGATIVE: Registration with missing email returns MissingEmail
  //    with no user created
  // --------------------------------------------------------------------------
  test('(negative) registration without email returns MissingEmail error', async () => {
    const res = await request('POST', '/auth/users', {
      credentials: { username: 'noemail', password: 'Pass1!' }
    });

    // Assert: 400 with MissingEmail
    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.type).toBe('ClientError');
    expect(error.name).toBe('MissingEmail');
    expect(error.message).toBeDefined();

    // Verify no user was created
    const dbUser = await DAC.db.findUserByUsername('noemail');
    expect(dbUser).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 4. QUERY, NEGATIVE: Registration with non-CMU email returns InvalidEmail
  //    with no user created
  // --------------------------------------------------------------------------
  test('(negative) registration with non-CMU email returns InvalidEmail error', async () => {
    const res = await request('POST', '/auth/users', {
      credentials: { username: 'badmail', password: 'Pass1!' },
      email: 'badmail@gmail.com',
      agreed: true
    });

    // Assert: 400 with InvalidEmail
    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.type).toBe('ClientError');
    expect(error.name).toBe('InvalidEmail');
    expect(error.message).toContain('CMU');

    // Verify no user was created
    const dbUser = await DAC.db.findUserByUsername('badmail');
    expect(dbUser).toBeNull();
  });
});
