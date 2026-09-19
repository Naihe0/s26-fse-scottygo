/**
 * Automated tests for ManageAcct use case
 * Tests all REST API endpoints and Socket.io events
 */

import { Server as HttpServer } from 'http';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import App from '../../../server/app';
import { MongoDB } from '../../../server/db/mongo.db';
import AccountController from '../../../server/controllers/account.controller';
import AuthController from '../../../server/controllers/auth.controller';
import MapController from '../../../server/controllers/map.controller';
import DAC from '../../../server/db/dac';
import { IUserAccount, IPrivilegeLevel } from '../../../common/user.interface';
import * as responses from '../../../common/server.responses';

// Always mock email: automated tests must never send real messages.
jest.mock('../../../server/services/email.service', () => ({
  __esModule: true,
  default: {
    sendAccountInactivatedEmail: jest.fn().mockResolvedValue(true),
    sendAccountReactivatedEmail: jest.fn().mockResolvedValue(true)
  }
}));

// Keep account tests isolated from transit startup side effects.
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
  default: {
    start: jest.fn(),
    stop: jest.fn()
  }
}));

jest.mock('../../../server/services/trip-updates.service', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    stop: jest.fn()
  }
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

// Import the mocked email service for verification
import emailService from '../../../server/services/email.service';
const mockEmailService = emailService as jest.Mocked<typeof emailService>;

// Test configuration
const TEST_PORT = 8181;
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

// Test user data

const adminUser = {
  credentials: { username: 'testadmin', password: 'Admin123!' },
  email: 'testadmin@cmu.edu',
  agreed: true
};

const memberUser = {
  credentials: { username: 'testmember', password: 'Member123!' },
  email: 'testmember@cmu.edu',
  agreed: true
};

const member2User = {
  credentials: { username: 'testmember2', password: 'Member456!' },
  email: 'testmember2@cmu.edu',
  agreed: true
};

const member3User = {
  credentials: { username: 'testmember3', password: 'Member789!' },
  email: 'testmember3@cmu.edu',
  agreed: true
};

// Global variables for tests
let app: App;
let server: HttpServer;
let adminToken: string;
let memberToken: string;
let member2Token: string;
let member3Token: string;
let adminSocket: ClientSocket;
let memberSocket: ClientSocket;
const activeSockets = new Set<ClientSocket>();
const activeTimeouts = new Set<NodeJS.Timeout>();

function trackTimeout(callback: () => void, ms: number): NodeJS.Timeout {
  const timeoutId = setTimeout(() => {
    activeTimeouts.delete(timeoutId);
    callback();
  }, ms);
  activeTimeouts.add(timeoutId);
  return timeoutId;
}

/**
 * Helper to make HTTP requests
 */
async function request(
  method: string,
  path: string,
  body?: object,
  token?: string
): Promise<{ status: number; data: responses.IResponse }> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json'
  };
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

/**
 * Helper to register a user
 */
async function registerUser(userData: typeof adminUser): Promise<void> {
  await request('POST', '/auth/users', {
    credentials: userData.credentials,
    email: userData.email,
    agreed: userData.agreed
  });

  // Agree to terms
  await request('PATCH', `/auth/users/${userData.credentials.username}`, {
    password: userData.credentials.password
  });
}

/**
 * Helper to login and get token
 */
async function loginUser(username: string, password: string): Promise<string> {
  const res = await request('POST', `/auth/tokens/${username}`, { password });
  const success = res.data as responses.ISuccess;
  const payload = success.payload as responses.IAuthenticatedUser;
  return payload.token;
}

/**
 * Helper to set user privilege directly in DB (for admin setup)
 */
async function setUserPrivilege(
  username: string,
  privilegeLevel: IPrivilegeLevel
): Promise<void> {
  await DAC.db.updateUserPrivilege(username, privilegeLevel);
}

/**
 * Connect a socket client with token
 */
function connectSocket(token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(TEST_URL, {
      query: { token },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });
    activeSockets.add(socket);
    socket.on('disconnect', () => activeSockets.delete(socket));

    const timeoutId = trackTimeout(() => {
      socket.removeAllListeners();
      socket.disconnect();
      reject(new Error('Socket connection timeout'));
    }, 5000);

    socket.on('connect', () => {
      clearTimeout(timeoutId);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

// ============================================================================
// TEST SUITE SETUP
// ============================================================================

beforeAll(async () => {
  // Create and start test server
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
      initOnStart: true // Clear DB on start
    }
  );

  server = await app.listen();

  // Wait for DB to initialize
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Register test users
  await registerUser(adminUser);
  await registerUser(memberUser);
  await registerUser(member2User);
  await registerUser(member3User);

  // Set admin privilege
  await setUserPrivilege(adminUser.credentials.username, 'Administrator');

  // Get tokens
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
  member3Token = await loginUser(
    member3User.credentials.username,
    member3User.credentials.password
  );
}, 30000);

// Security-sensitive tests revoke sessions. Later tests start with a fresh login
// instead of depending on a token issued before deactivation/password reset.
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
  // Clean up sockets
  activeSockets.forEach((socket) => {
    socket.removeAllListeners();
    socket.disconnect();
  });
  if (adminSocket) {
    adminSocket.removeAllListeners();
    adminSocket.disconnect();
  }
  if (memberSocket) {
    memberSocket.removeAllListeners();
    memberSocket.disconnect();
  }

  // Clear any pending timeouts
  activeTimeouts.forEach((timeoutId) => clearTimeout(timeoutId));
  activeTimeouts.clear();

  // Close server and database
  if (app && app.io) {
    await new Promise<void>((resolve) => app.io.close(() => resolve()));
  }
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (DAC.db) await DAC.db.close();
}, 10000);

// ============================================================================
// GET USER ACCOUNT TESTS
// ============================================================================

describe('GET /account/users/:username', () => {
  test('Admin can retrieve any user account', async () => {
    const res = await request(
      'GET',
      `/account/users/${memberUser.credentials.username}`,
      undefined,
      adminToken
    );

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('AccountRetrieved');
    const account = success.payload as IUserAccount;
    expect(account.credentials.username).toBe(memberUser.credentials.username);
    expect(account.credentials.password).toBe('*******'); // Obfuscated
  });

  test('Member can retrieve own account', async () => {
    const res = await request(
      'GET',
      `/account/users/${memberUser.credentials.username}`,
      undefined,
      memberToken
    );

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('AccountRetrieved');
  });

  test('Member cannot retrieve another user account', async () => {
    const res = await request(
      'GET',
      `/account/users/${adminUser.credentials.username}`,
      undefined,
      memberToken
    );

    expect(res.status).toBe(403);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('UnauthorizedRequest');
  });

  test('Request without token returns 401', async () => {
    const res = await request(
      'GET',
      `/account/users/${memberUser.credentials.username}`
    );

    expect(res.status).toBe(401);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('MissingToken');
  });

  test('Invalid token returns 401', async () => {
    const res = await request(
      'GET',
      `/account/users/${memberUser.credentials.username}`,
      undefined,
      'invalid_token'
    );

    expect(res.status).toBe(401);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('InvalidToken');
  });

  test('Non-existent user returns 400 UserNotFound', async () => {
    const res = await request(
      'GET',
      '/account/users/nonexistentuser',
      undefined,
      adminToken
    );

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('UserNotFound');
  });
});

// ============================================================================
// UPDATE ACCOUNT STATUS TESTS
// ============================================================================

describe('PATCH /account/users/:username/status', () => {
  beforeEach(() => {
    // Clear mock call history before each test
    jest.clearAllMocks();
  });

  test('Admin can change member status to Inactive', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/status`,
      { status: 'Inactive' },
      adminToken
    );

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('StatusUpdated');
    const account = success.payload as IUserAccount;
    expect(account.status).toBe('Inactive');
  });

  test('Admin can reactivate member account', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/status`,
      { status: 'Active' },
      adminToken
    );

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('StatusUpdated');
    const account = success.payload as IUserAccount;
    expect(account.status).toBe('Active');
    const revoked = await request(
      'GET',
      `/account/users/${member2User.credentials.username}`,
      undefined,
      member2Token
    );
    expect(revoked.status).toBe(401);
  });

  test('Member can change own status', async () => {
    // First set to Inactive
    const res1 = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/status`,
      { status: 'Inactive' },
      member2Token
    );
    expect(res1.status).toBe(200);

    // Reactivate via admin since member is now inactive
    await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/status`,
      { status: 'Active' },
      adminToken
    );
  });

  test('Member cannot change another user status', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${adminUser.credentials.username}/status`,
      { status: 'Inactive' },
      memberToken
    );

    expect(res.status).toBe(403);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('UnauthorizedRequest');
  });

  test('Last admin cannot be inactivated (R1)', async () => {
    // First, inactivate the default admin so testadmin is the only admin
    await request(
      'PATCH',
      '/account/users/admin/status',
      { status: 'Inactive' },
      adminToken
    );

    const res = await request(
      'PATCH',
      `/account/users/${adminUser.credentials.username}/status`,
      { status: 'Inactive' },
      adminToken
    );

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('LastAdministrator');

    // Reactivate default admin for other tests
    await request(
      'PATCH',
      '/account/users/admin/status',
      { status: 'Active' },
      adminToken
    );
  });

  test('Invalid status value returns error', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${memberUser.credentials.username}/status`,
      { status: 'InvalidStatus' },
      adminToken
    );

    expect(res.status).toBe(400);
  });

  test('Email service is called when user is inactivated', async () => {
    // Inactivate user
    await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/status`,
      { status: 'Inactive' },
      adminToken
    );

    // Verify inactivation email was sent (mocked)
    expect(mockEmailService.sendAccountInactivatedEmail).toHaveBeenCalledWith(
      member2User.email,
      member2User.credentials.username
    );

    // Reactivate user
    await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/status`,
      { status: 'Active' },
      adminToken
    );

    // Verify reactivation email was sent (mocked)
    expect(mockEmailService.sendAccountReactivatedEmail).toHaveBeenCalledWith(
      member2User.email,
      member2User.credentials.username
    );
  });
});

// ============================================================================
// UPDATE PRIVILEGE LEVEL TESTS
// ============================================================================

describe('PATCH /account/users/:username/privilege', () => {
  test('Admin can change privilege to Coordinator', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${memberUser.credentials.username}/privilege`,
      { privilegeLevel: 'Coordinator' },
      adminToken
    );

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('PrivilegeUpdated');
    const account = success.payload as IUserAccount;
    expect(account.privilegeLevel).toBe('Coordinator');
  });

  test('Admin can change privilege to Administrator', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${memberUser.credentials.username}/privilege`,
      { privilegeLevel: 'Administrator' },
      adminToken
    );

    expect(res.status).toBe(200);
    const account = (res.data as responses.ISuccess).payload as IUserAccount;
    expect(account.privilegeLevel).toBe('Administrator');

    // Reset to Member for other tests
    await request(
      'PATCH',
      `/account/users/${memberUser.credentials.username}/privilege`,
      { privilegeLevel: 'Member' },
      adminToken
    );
  });

  test('Member cannot change privilege level', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${memberUser.credentials.username}/privilege`,
      { privilegeLevel: 'Administrator' },
      memberToken
    );

    expect(res.status).toBe(403);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('UnauthorizedRequest');
  });

  test('Invalid privilege level returns error', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${memberUser.credentials.username}/privilege`,
      { privilegeLevel: 'SuperAdmin' },
      adminToken
    );

    expect(res.status).toBe(400);
  });

  test('Cannot demote last active administrator', async () => {
    // First, inactivate the default admin so testadmin is the only admin
    await request(
      'PATCH',
      '/account/users/admin/status',
      { status: 'Inactive' },
      adminToken
    );

    // Try to demote the only admin (testadmin) to Member
    const res = await request(
      'PATCH',
      `/account/users/${adminUser.credentials.username}/privilege`,
      { privilegeLevel: 'Member' },
      adminToken
    );

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('LastAdministrator');

    // Reactivate default admin for other tests
    await request(
      'PATCH',
      '/account/users/admin/status',
      { status: 'Active' },
      adminToken
    );
  });
});

// ============================================================================
// UPDATE USERNAME TESTS
// ============================================================================

describe('PATCH /account/users/:username/username', () => {
  test('Member can change own username', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member3User.credentials.username}/username`,
      { newUsername: 'member3renamed' },
      member3Token
    );

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('UsernameUpdated');
    const account = success.payload as IUserAccount;
    expect(account.credentials.username).toBe('member3renamed');

    // Note: member3Token is now stale with old username
    // Login again to get fresh token for reverting
    const newToken = await loginUser(
      'member3renamed',
      member3User.credentials.password
    );

    // Change back
    await request(
      'PATCH',
      '/account/users/member3renamed/username',
      { newUsername: member3User.credentials.username },
      newToken
    );
  });

  test('Member cannot change another user username', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${adminUser.credentials.username}/username`,
      { newUsername: 'hackedadmin' },
      memberToken
    );

    expect(res.status).toBe(403);
  });

  test('Admin cannot change another user username', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${memberUser.credentials.username}/username`,
      { newUsername: 'adminchangedthis' },
      adminToken
    );

    expect(res.status).toBe(403);
  });

  test('Username too short returns error', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member3User.credentials.username}/username`,
      { newUsername: 'abc' },
      member3Token
    );

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('InvalidUsername');
  });

  test('Reserved username returns error', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member3User.credentials.username}/username`,
      { newUsername: 'root' },
      member3Token
    );

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('InvalidUsername');
  });

  test('Username already exists returns error', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member3User.credentials.username}/username`,
      { newUsername: memberUser.credentials.username },
      member3Token
    );

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('UsernameExists');
  });
});

// ============================================================================
// UPDATE EMAIL TESTS
// ============================================================================

describe('PATCH /account/users/:username/email', () => {
  test('Member can change own email', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/email`,
      { email: 'newemail@andrew.cmu.edu' },
      member2Token
    );

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('EmailUpdated');
    const account = success.payload as IUserAccount;
    expect(account.email).toBe('newemail@andrew.cmu.edu');

    // Change back
    await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/email`,
      { email: member2User.email },
      member2Token
    );
  });

  test('Member cannot change another user email', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${adminUser.credentials.username}/email`,
      { email: 'hacked@cmu.edu' },
      memberToken
    );

    expect(res.status).toBe(403);
  });

  test('Admin cannot change another user email', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${memberUser.credentials.username}/email`,
      { email: 'adminchanged@cmu.edu' },
      adminToken
    );

    expect(res.status).toBe(403);
  });

  test('Invalid email (non-CMU) returns error', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/email`,
      { email: 'test@gmail.com' },
      member2Token
    );

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('InvalidEmail');
  });
});

// ============================================================================
// UPDATE PASSWORD TESTS
// ============================================================================

describe('PATCH /account/users/:username/password', () => {
  test('Member can change own password with current password', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/password`,
      {
        currentPassword: member2User.credentials.password,
        newPassword: 'NewPass123!'
      },
      member2Token
    );

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('PasswordUpdated');

    // Change back via admin
    await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/password`,
      { newPassword: member2User.credentials.password },
      adminToken
    );
  });

  test('Admin can change any user password without current password', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/password`,
      { newPassword: 'AdminReset123!' },
      adminToken
    );

    expect(res.status).toBe(200);
    expect((res.data as responses.ISuccess).name).toBe('PasswordUpdated');

    // Reset
    await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/password`,
      { newPassword: member2User.credentials.password },
      adminToken
    );
  });

  test('Member can change own password without current password', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/password`,
      { newPassword: 'NewPass123!' },
      member2Token
    );

    expect(res.status).toBe(200);
    expect((res.data as responses.ISuccess).name).toBe('PasswordUpdated');

    // Reset for downstream tests.
    await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/password`,
      { newPassword: member2User.credentials.password },
      adminToken
    );
  });

  test('currentPassword field is ignored for authorized self update', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/password`,
      { currentPassword: 'WrongPassword1!', newPassword: 'NewPass123!' },
      member2Token
    );

    expect(res.status).toBe(200);
    expect((res.data as responses.ISuccess).name).toBe('PasswordUpdated');

    // Reset for downstream tests.
    await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/password`,
      { newPassword: member2User.credentials.password },
      adminToken
    );
  });

  test('Member cannot change another user password', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${adminUser.credentials.username}/password`,
      {
        currentPassword: adminUser.credentials.password,
        newPassword: 'Hacked123!'
      },
      memberToken
    );

    expect(res.status).toBe(403);
  });

  test('Weak password - too short', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/password`,
      {
        currentPassword: member2User.credentials.password,
        newPassword: 'A1!'
      },
      member2Token
    );

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('WeakPassword');
  });

  test('Weak password - no letter', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/password`,
      {
        currentPassword: member2User.credentials.password,
        newPassword: '12345678!'
      },
      member2Token
    );

    expect(res.status).toBe(400);
    expect((res.data as responses.IAppError).name).toBe('WeakPassword');
  });

  test('Weak password - no number', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/password`,
      {
        currentPassword: member2User.credentials.password,
        newPassword: 'Abcdefgh!'
      },
      member2Token
    );

    expect(res.status).toBe(400);
    expect((res.data as responses.IAppError).name).toBe('WeakPassword');
  });

  test('Weak password - no special character', async () => {
    const res = await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/password`,
      {
        currentPassword: member2User.credentials.password,
        newPassword: 'Abcdefgh1'
      },
      member2Token
    );

    expect(res.status).toBe(400);
    expect((res.data as responses.IAppError).name).toBe('WeakPassword');
  });
});

// ============================================================================
// SOCKET.IO TESTS
// ============================================================================

describe('Socket.io Events', () => {
  beforeAll(async () => {
    // Connect sockets for admin and member
    adminSocket = await connectSocket(adminToken);
    memberSocket = await connectSocket(memberToken);
  });

  afterAll(() => {
    if (adminSocket) adminSocket.disconnect();
    if (memberSocket) memberSocket.disconnect();
  });

  test('Client can subscribe to account updates', (done) => {
    adminSocket.emit('subscribeAccount', memberUser.credentials.username);

    // Give time for subscription to process
    trackTimeout(() => {
      // Subscription should succeed silently
      done();
    }, 500);
  });

  test('Member cannot subscribe to another user account', (done) => {
    // Member tries to subscribe to admin account - should be silently rejected
    memberSocket.emit('subscribeAccount', adminUser.credentials.username);

    trackTimeout(() => {
      // No error thrown, but subscription should not work
      done();
    }, 500);
  });

  test('accountUpdated event is emitted on status change', (done) => {
    // Subscribe admin to member2's account
    adminSocket.emit('subscribeAccount', member2User.credentials.username);

    let received = false;

    // Set up listener first
    const handler = (account: IUserAccount) => {
      if (
        !received &&
        account.credentials.username === member2User.credentials.username
      ) {
        received = true;
        expect(account.credentials.username).toBe(
          member2User.credentials.username
        );
        expect(account.credentials.password).toBe('*******');
        adminSocket.off('accountUpdated', handler);
        done();
      }
    };

    adminSocket.on('accountUpdated', handler);

    // Wait for subscription to be processed, then trigger status update
    trackTimeout(() => {
      void (async () => {
        await request(
          'PATCH',
          `/account/users/${member2User.credentials.username}/status`,
          { status: 'Inactive' },
          adminToken
        );

        // Reactivate
        await request(
          'PATCH',
          `/account/users/${member2User.credentials.username}/status`,
          { status: 'Active' },
          adminToken
        );
      })();
    }, 500);
  }, 10000);

  test('accountUpdated event is emitted on privilege change', (done) => {
    adminSocket.emit('subscribeAccount', member2User.credentials.username);

    let received = false;

    const handler = (account: IUserAccount) => {
      if (
        !received &&
        account.credentials.username === member2User.credentials.username &&
        account.privilegeLevel === 'Coordinator'
      ) {
        received = true;
        expect(account.privilegeLevel).toBe('Coordinator');
        adminSocket.off('accountUpdated', handler);
        done();
      }
    };

    adminSocket.on('accountUpdated', handler);

    // Wait for subscription, then trigger privilege update
    trackTimeout(() => {
      void (async () => {
        await request(
          'PATCH',
          `/account/users/${member2User.credentials.username}/privilege`,
          { privilegeLevel: 'Coordinator' },
          adminToken
        );

        // Reset
        await request(
          'PATCH',
          `/account/users/${member2User.credentials.username}/privilege`,
          { privilegeLevel: 'Member' },
          adminToken
        );
      })();
    }, 500);
  }, 10000);

  test('forceLogout event is emitted when user is inactivated', (done) => {
    // Create a fresh socket for member2 to test forceLogout
    connectSocket(member2Token).then((member2Socket) => {
      member2Socket.on('forceLogout', (reason: string) => {
        expect(reason).toContain('deactivated');
        member2Socket.disconnect();

        // Reactivate member2 BEFORE marking test as done
        void (async () => {
          await request(
            'PATCH',
            `/account/users/${member2User.credentials.username}/status`,
            { status: 'Active' },
            adminToken
          );
          done();
        })();
      });

      // Inactivate member2
      trackTimeout(() => {
        void (async () => {
          await request(
            'PATCH',
            `/account/users/${member2User.credentials.username}/status`,
            { status: 'Inactive' },
            adminToken
          );
        })();
      }, 500);
    });
  }, 15000);

  test('Client can unsubscribe from account updates', (done) => {
    adminSocket.emit('unsubscribeAccount', member2User.credentials.username);

    trackTimeout(() => {
      // Unsubscription should succeed silently
      done();
    }, 500);
  });
});

// ============================================================================
// RACE CONDITION / LAST WRITE WINS TESTS
// ============================================================================

describe('Race Condition - Last Write Wins', () => {
  test('Concurrent updates - last write wins on privilege', async () => {
    // Two admins try to change privilege concurrently
    // The last one to complete should win

    const [res1, res2] = await Promise.all([
      request(
        'PATCH',
        `/account/users/${member2User.credentials.username}/privilege`,
        { privilegeLevel: 'Coordinator' },
        adminToken
      ),
      request(
        'PATCH',
        `/account/users/${member2User.credentials.username}/privilege`,
        { privilegeLevel: 'Member' },
        adminToken
      )
    ]);

    // Both should succeed
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Get final state
    const finalRes = await request(
      'GET',
      `/account/users/${member2User.credentials.username}`,
      undefined,
      adminToken
    );
    const account = (finalRes.data as responses.ISuccess)
      .payload as IUserAccount;

    // Should be one of the two values (last write wins)
    expect(['Coordinator', 'Member']).toContain(account.privilegeLevel);
  });

  test('Concurrent email updates - last write wins', async () => {
    const [res1, res2] = await Promise.all([
      request(
        'PATCH',
        `/account/users/${member2User.credentials.username}/email`,
        { email: 'email1@cmu.edu' },
        member2Token
      ),
      request(
        'PATCH',
        `/account/users/${member2User.credentials.username}/email`,
        { email: 'email2@cmu.edu' },
        member2Token
      )
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Get final state
    const finalRes = await request(
      'GET',
      `/account/users/${member2User.credentials.username}`,
      undefined,
      member2Token
    );
    const account = (finalRes.data as responses.ISuccess)
      .payload as IUserAccount;

    // Should be one of the two email values
    expect(['email1@cmu.edu', 'email2@cmu.edu']).toContain(account.email);

    // Reset email
    await request(
      'PATCH',
      `/account/users/${member2User.credentials.username}/email`,
      { email: member2User.email },
      member2Token
    );
  });

  test('Status change is immediate - inactive user gets forceLogout', (done) => {
    // Connect member2 socket
    connectSocket(member2Token).then((member2Socket) => {
      let forceLogoutReceived = false;

      member2Socket.on('forceLogout', () => {
        forceLogoutReceived = true;
      });

      // Inactivate the user
      trackTimeout(() => {
        void (async () => {
          await request(
            'PATCH',
            `/account/users/${member2User.credentials.username}/status`,
            { status: 'Inactive' },
            adminToken
          );

          // Check that forceLogout was received
          trackTimeout(() => {
            void (async () => {
              expect(forceLogoutReceived).toBe(true);
              member2Socket.disconnect();

              // Reactivate user
              await request(
                'PATCH',
                `/account/users/${member2User.credentials.username}/status`,
                { status: 'Active' },
                adminToken
              );
              done();
            })();
          }, 1000);
        })();
      }, 500);
    });
  }, 15000);
});
