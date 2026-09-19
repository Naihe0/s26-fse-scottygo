/**
 * Integration tests for ManageAcct use case
 * Tests the full REST API stack: HTTP request → Express → Controller → Model → MongoDB
 *
 * Uses a real test database (scottygo_test_manageacct_int) that is
 * cleared and re-seeded on every run via initOnStart: true.
 */

import { Server as HttpServer } from 'http';
import App from '../../../server/app';
import { MongoDB } from '../../../server/db/mongo.db';
import AccountController from '../../../server/controllers/account.controller';
import AuthController from '../../../server/controllers/auth.controller';
import MapController from '../../../server/controllers/map.controller';
import DAC from '../../../server/db/dac';
import { IUserAccount, IPrivilegeLevel } from '../../../common/user.interface';
import * as responses from '../../../common/server.responses';

// Mock external services that are irrelevant to account management
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

// ============================================================================
// Test configuration
// ============================================================================

const TEST_PORT = 8184;
const TEST_URL = `http://localhost:${TEST_PORT}`;
const TEST_DB_URL =
  process.env.TEST_DB_URL ??
  (process.env.DB_URL && process.env.DEV_DB
    ? `${process.env.DB_URL}${process.env.DEV_DB}`
    : '');

if (!TEST_DB_URL) {
  throw new Error(
    'Missing DB_URL/DEV_DB (or TEST_DB_URL override). Refusing to run DB-writing tests without explicit DEV database configuration.'
  );
}

// Test users
const adminUser = {
  credentials: { username: 'intadmin', password: 'Admin123!' },
  email: 'intadmin@cmu.edu',
  agreed: true
};

const memberUser = {
  credentials: { username: 'intmember', password: 'Member123!' },
  email: 'intmember@cmu.edu',
  agreed: true
};

const member2User = {
  credentials: { username: 'intmember2', password: 'Member456!' },
  email: 'intmember2@cmu.edu',
  agreed: true
};

// Global state
let app: App;
let server: HttpServer;
let adminToken: string;
let memberToken: string;
let member2Token: string;

// ============================================================================
// Helpers
// ============================================================================

async function request(
  method: string,
  path: string,
  body?: object,
  token?: string
): Promise<{ status: number; data: responses.IResponse }> {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await fetch(`${TEST_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function registerUser(userData: typeof adminUser): Promise<void> {
  await request('POST', '/auth/users', {
    credentials: userData.credentials,
    email: userData.email,
    agreed: userData.agreed
  });
  await request('PATCH', `/auth/users/${userData.credentials.username}`, {
    password: userData.credentials.password
  });
}

async function loginUser(username: string, password: string): Promise<string> {
  const res = await request('POST', `/auth/tokens/${username}`, { password });
  const success = res.data as responses.ISuccess;
  const payload = success.payload as responses.IAuthenticatedUser;
  return payload.token;
}

async function setUserPrivilege(
  username: string,
  privilegeLevel: IPrivilegeLevel
): Promise<void> {
  await DAC.db.updateUserPrivilege(username, privilegeLevel);
}

/**
 * Helper: GET account and return the IUserAccount payload
 */
async function getAccount(
  username: string,
  token: string
): Promise<IUserAccount> {
  const res = await request(
    'GET',
    `/account/users/${username}`,
    undefined,
    token
  );
  return (res.data as responses.ISuccess).payload as IUserAccount;
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeAll(async () => {
  const db = new MongoDB(TEST_DB_URL);
  app = new App(
    [
      MapController.getInstance('/'),
      AuthController.getInstance('/auth'),
      AccountController.getInstance('/account')
    ],
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

  // Register test users
  await registerUser(adminUser);
  await registerUser(memberUser);
  await registerUser(member2User);

  // Promote intadmin to Administrator
  await setUserPrivilege(adminUser.credentials.username, 'Administrator');

  // Get auth tokens
  adminToken = await loginUser(
    adminUser.credentials.username,
    adminUser.credentials.password
  );
  memberToken = await loginUser(
    memberUser.credentials.username,
    memberUser.credentials.password
  );
  member2Token = await loginUser(
    member2User.credentials.username,
    member2User.credentials.password
  );
}, 30000);

beforeEach(async () => {
  const account = await DAC.db.findUserAccountByUsername(
    member2User.credentials.username
  );
  if (account?.status === 'Active') {
    member2Token = await loginUser(
      member2User.credentials.username,
      member2User.credentials.password
    );
  }
});

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

describe('ManageAcct Integration Tests', () => {
  // --------------------------------------------------------------------------
  // 1. POSITIVE: Admin changes a member's privilege and the change persists
  // --------------------------------------------------------------------------
  test('admin promotes member to Coordinator and GET confirms the change', async () => {
    // Act: update privilege
    const patchRes = await request(
      'PATCH',
      `/account/users/${memberUser.credentials.username}/privilege`,
      { privilegeLevel: 'Coordinator' },
      adminToken
    );

    // Assert response
    expect(patchRes.status).toBe(200);
    const patchSuccess = patchRes.data as responses.ISuccess;
    expect(patchSuccess.name).toBe('PrivilegeUpdated');
    const patchAccount = patchSuccess.payload as IUserAccount;
    expect(patchAccount.privilegeLevel).toBe('Coordinator');
    expect(patchAccount.credentials.password).toBe('*******');

    // Verify: follow-up READ confirms persisted state
    const account = await getAccount(
      memberUser.credentials.username,
      adminToken
    );
    expect(account.privilegeLevel).toBe('Coordinator');

    // Cleanup: reset to Member
    await request(
      'PATCH',
      `/account/users/${memberUser.credentials.username}/privilege`,
      { privilegeLevel: 'Member' },
      adminToken
    );
  });

  // --------------------------------------------------------------------------
  // 2. POSITIVE: Admin deactivates a member's account and GET confirms
  // --------------------------------------------------------------------------
  test('admin deactivates member account and GET confirms Inactive status', async () => {
    const patchRes = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/status`,
      { status: 'Inactive' },
      adminToken
    );

    expect(patchRes.status).toBe(200);
    const patchSuccess = patchRes.data as responses.ISuccess;
    expect(patchSuccess.name).toBe('StatusUpdated');
    expect((patchSuccess.payload as IUserAccount).status).toBe('Inactive');

    // Verify: GET confirms persisted state
    const account = await getAccount(
      member2User.credentials.username,
      adminToken
    );
    expect(account.status).toBe('Inactive');

    // Cleanup: reactivate
    await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/status`,
      { status: 'Active' },
      adminToken
    );
  });

  // --------------------------------------------------------------------------
  // 3. POSITIVE: Member changes own email and GET confirms the change
  // --------------------------------------------------------------------------
  test('member updates own email and GET confirms the new email', async () => {
    const newEmail = 'newemail@andrew.cmu.edu';

    const patchRes = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/email`,
      { email: newEmail },
      member2Token
    );

    expect(patchRes.status).toBe(200);
    const patchSuccess = patchRes.data as responses.ISuccess;
    expect(patchSuccess.name).toBe('EmailUpdated');
    expect((patchSuccess.payload as IUserAccount).email).toBe(newEmail);

    // Verify: GET confirms persisted state
    const account = await getAccount(
      member2User.credentials.username,
      member2Token
    );
    expect(account.email).toBe(newEmail);

    // Cleanup: restore original email
    await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/email`,
      { email: member2User.email },
      member2Token
    );
  });

  // --------------------------------------------------------------------------
  // 4. POSITIVE: Admin changes another user's password, user can log in with it
  // --------------------------------------------------------------------------
  test('admin resets member password and member can log in with the new password', async () => {
    const newPassword = 'Reset999!';

    const patchRes = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/password`,
      { newPassword },
      adminToken
    );

    expect(patchRes.status).toBe(200);
    expect((patchRes.data as responses.ISuccess).name).toBe('PasswordUpdated');

    const revoked = await request(
      'GET',
      `/account/users/${member2User.credentials.username}`,
      undefined,
      member2Token
    );
    expect(revoked.status).toBe(401);

    // Verify: member can log in with the new password
    const loginRes = await request(
      'POST',
      `/auth/tokens/${member2User.credentials.username}`,
      { password: newPassword }
    );
    expect(loginRes.status).toBe(200);
    expect((loginRes.data as responses.ISuccess).name).toBe(
      'UserAuthenticated'
    );

    // Cleanup: restore original password
    await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/password`,
      { newPassword: member2User.credentials.password },
      adminToken
    );
  });

  // --------------------------------------------------------------------------
  // 5. NEGATIVE: Last administrator cannot be demoted (R1 rule)
  // --------------------------------------------------------------------------
  test('(negative) sole active administrator cannot be demoted', async () => {
    // Setup: inactivate default admin so intadmin is the only one
    await request(
      'PATCH',
      '/account/users/admin/status',
      { status: 'Inactive' },
      adminToken
    );

    // Act: try to demote the sole admin
    const res = await request(
      'PATCH',
      `/account/users/${adminUser.credentials.username}/privilege`,
      { privilegeLevel: 'Member' },
      adminToken
    );

    // Assert: rejected with LastAdministrator
    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.type).toBe('ClientError');
    expect(error.name).toBe('LastAdministrator');

    // Verify: admin's privilege is unchanged
    const account = await getAccount(
      adminUser.credentials.username,
      adminToken
    );
    expect(account.privilegeLevel).toBe('Administrator');

    // Cleanup: reactivate default admin
    await request(
      'PATCH',
      '/account/users/admin/status',
      { status: 'Active' },
      adminToken
    );
  });

  // --------------------------------------------------------------------------
  // 6. NEGATIVE: Member cannot change another user's privilege level
  // --------------------------------------------------------------------------
  test('(negative) member cannot change another user privilege level', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/privilege`,
      { privilegeLevel: 'Administrator' },
      memberToken
    );

    expect(res.status).toBe(403);
    const error = res.data as responses.IAppError;
    expect(error.type).toBe('ClientError');
    expect(error.name).toBe('UnauthorizedRequest');
    expect(error.message).toContain('administrators');

    // Verify: member2's privilege is unchanged
    const account = await getAccount(
      member2User.credentials.username,
      adminToken
    );
    expect(account.privilegeLevel).toBe('Member');
  });

  // --------------------------------------------------------------------------
  // 7. NEGATIVE: Non-CMU email is rejected
  // --------------------------------------------------------------------------
  test('(negative) email update with non-CMU address is rejected', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/email`,
      { email: 'user@gmail.com' },
      member2Token
    );

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('InvalidEmail');
    expect(error.message).toContain('CMU');

    // Verify: email is unchanged
    const account = await getAccount(
      member2User.credentials.username,
      member2Token
    );
    expect(account.email).toBe(member2User.email);
  });

  // --------------------------------------------------------------------------
  // 8. NEGATIVE: Admin cannot change another user's username (R3 rule)
  // --------------------------------------------------------------------------
  test('(negative) administrator cannot change another user username', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${memberUser.credentials.username}/username`,
      { newUsername: 'adminpickedthis' },
      adminToken
    );

    expect(res.status).toBe(403);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('UnauthorizedRequest');
    expect(error.message).toContain('your own username');

    // Verify: username is unchanged
    const account = await getAccount(
      memberUser.credentials.username,
      adminToken
    );
    expect(account.credentials.username).toBe(memberUser.credentials.username);
  });
});
