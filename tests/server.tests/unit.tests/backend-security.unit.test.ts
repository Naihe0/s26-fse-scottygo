import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import type { Socket } from 'socket.io';
import { JWT_KEY } from '../../../server/env';
import { User } from '../../../server/models/user.model';
import type { IUserAccount } from '../../../common/user.interface';
import { authenticateSession } from '../../../server/services/authentication.service';
import {
  authenticateSocket,
  configureSocketSession,
  subscribeSocketToAccount,
  updateSocketAccountPermissions
} from '../../../server/services/socket-session.service';
import MapController from '../../../server/controllers/map.controller';
import AuthController from '../../../server/controllers/auth.controller';
import {
  validatePasswordStrength,
  validateUsernameFormat
} from '../../../server/models/user.validation';
import { NotificationModel } from '../../../server/models/notification.model';
import notificationSources from '../../../server/services/notification-sources.service';
import { MongoDB } from '../../../server/db/mongo.db';

const account: IUserAccount = {
  _id: 'immutable-member-id',
  credentials: { username: 'renamed', password: 'hash' },
  email: 'member@andrew.cmu.edu',
  agreed: true,
  status: 'Active',
  privilegeLevel: 'Member',
  onboardingComplete: true
};
const token = (extra = {}) =>
  jwt.sign({ userId: account._id, username: 'oldname', ...extra }, JWT_KEY);
const response = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};
const socket = () => ({
  handshake: { query: { token: token() }, auth: {} },
  data: { account },
  user: { userId: account._id, username: 'oldname' },
  rooms: new Set([
    'id',
    'admin:usernames',
    'account:another',
    'account:renamed'
  ]),
  join: jest.fn(),
  leave: jest.fn(),
  emit: jest.fn(),
  disconnect: jest.fn(),
  use: jest.fn(),
  once: jest.fn()
});

beforeEach(() => {
  jest.spyOn(User, 'getUserAccountById').mockResolvedValue({ ...account });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('Current account and session authorization', () => {
  test('legacy v0 token resolves renamed account by immutable ID', async () => {
    const session = await authenticateSession(token());
    expect(User.getUserAccountById).toHaveBeenCalledWith(account._id);
    expect(session.payload.username).toBe('renamed');
  });
  test.each(['Inactive', 'deleted', 'revoked', 'unagreed'])(
    '%s accounts cannot reuse a signed token',
    async (state) => {
      if (state === 'deleted')
        jest
          .mocked(User.getUserAccountById)
          .mockRejectedValue(new Error('missing'));
      else
        jest.mocked(User.getUserAccountById).mockResolvedValue({
          ...account,
          status: state === 'Inactive' ? 'Inactive' : 'Active',
          agreed: state !== 'unagreed',
          tokenVersion: state === 'revoked' ? 1 : 0
        });
      await expect(authenticateSession(token())).rejects.toBeDefined();
    }
  );
  test('new token works after password reset while the old token is rejected', async () => {
    jest
      .mocked(User.getUserAccountById)
      .mockResolvedValue({ ...account, tokenVersion: 2 });
    await expect(authenticateSession(token())).rejects.toBeDefined();
    await expect(
      authenticateSession(token({ tokenVersion: 2 }))
    ).resolves.toBeDefined();
  });
  test.each([{ userId: {} }, { username: [] }, { tokenVersion: -1 }])(
    'rejects malformed signed claims %j before querying DB',
    async (claims) => {
      await expect(authenticateSession(token(claims))).rejects.toBeDefined();
      expect(User.getUserAccountById).not.toHaveBeenCalled();
    }
  );
  test('middleware denies inactive account and never calls the handler', async () => {
    jest
      .mocked(User.getUserAccountById)
      .mockResolvedValue({ ...account, status: 'Inactive' });
    const res = response();
    const next = jest.fn();
    await MapController.getInstance('/').authorize(
      { headers: { authorization: `Bearer ${token()}` } } as Request,
      res as unknown as Response,
      next
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
  test('map account lookup forbids other members before fetching their data', async () => {
    const lookup = jest.spyOn(User, 'getUserForUsername');
    const res = response();
    await MapController.getInstance('/').getUser(
      {
        params: { username: 'victim' },
        user: { userId: account._id }
      } as unknown as Request,
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(lookup).not.toHaveBeenCalled();
  });
  test('map account lookup permits owner and hides password', async () => {
    jest.spyOn(User, 'getUserForUsername').mockResolvedValue(account);
    const res = response();
    await MapController.getInstance('/').getUser(
      {
        params: { username: 'renamed' },
        user: { userId: account._id }
      } as unknown as Request,
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].payload.credentials.password).toBe(
      'obfuscated'
    );
  });
});

describe('Socket identity, authorization and expiry', () => {
  test('handshake refuses inactive users', async () => {
    jest
      .mocked(User.getUserAccountById)
      .mockResolvedValue({ ...account, status: 'Inactive' });
    const next = jest.fn();
    await authenticateSocket(socket() as unknown as Socket, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
  test('renamed token only subscribes to current account; malformed events are ignored', () => {
    const client = socket();
    for (const name of ['victim', 'oldname', {}, null])
      subscribeSocketToAccount(client as unknown as Socket, name);
    expect(client.join).not.toHaveBeenCalled();
    subscribeSocketToAccount(client as unknown as Socket, 'renamed');
    expect(client.join).toHaveBeenCalledWith('account:renamed');
  });
  test('demotion removes privileged rooms, preserving the own-account room', () => {
    const client = socket();
    updateSocketAccountPermissions(client as unknown as Socket, account);
    expect(client.leave.mock.calls).toEqual([
      ['admin:usernames'],
      ['account:another']
    ]);
  });
  test('passive sockets disconnect at JWT expiry', () => {
    jest.useFakeTimers();
    const client = socket();
    Object.assign(client.user, { exp: Math.floor(Date.now() / 1000) + 2 });
    configureSocketSession(client as unknown as Socket);
    jest.advanceTimersByTime(2_000);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.emit).toHaveBeenCalledWith(
      'forceLogout',
      expect.stringContaining('expired')
    );
  });
  test('a previously connected socket rechecks account on the next event', async () => {
    const client = socket();
    configureSocketSession(client as unknown as Socket);
    jest
      .mocked(User.getUserAccountById)
      .mockResolvedValue({ ...account, status: 'Inactive' });
    const packetGuard = client.use.mock.calls[0][0];
    const error = await new Promise((resolve) =>
      packetGuard(['subscribeAccount', 'renamed'], resolve)
    );
    expect(error).toBeInstanceOf(Error);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });
});

describe('Untrusted input', () => {
  test.each(['<img src=x>', 'user name', 'a'.repeat(65)])(
    'new username rejects %s',
    (value) => {
      expect(() => validateUsernameFormat(value)).toThrow(
        expect.objectContaining({ name: 'InvalidUsername' })
      );
    }
  );
  test('bcrypt passwords cannot silently truncate after 72 bytes', () => {
    expect(() => validatePasswordStrength('Pass1!' + 'a'.repeat(67))).toThrow(
      expect.objectContaining({ name: 'InvalidPassword' })
    );
  });
  test('login rejects non-string password before account lookup', async () => {
    const lookup = jest.spyOn(User, 'getUserAccount');
    const res = response();
    await AuthController.getInstance('/auth').login(
      { params: { username: 'member' }, body: { password: {} } } as Request,
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(lookup).not.toHaveBeenCalled();
  });
  test.each([
    { lat: 'NaN' },
    { lon: Infinity },
    { lat: 91 },
    { lon: -181 },
    { vid: {} },
    { comment: {} },
    { comment: 'x'.repeat(201) }
  ])(
    'invalid report rejected before upstream or DB calls %j',
    async (override) => {
      const lookup = jest.spyOn(notificationSources, 'getVehiclesForRoute');
      const data = {
        vid: 'bus1',
        routeId: '61C',
        lat: 40.44,
        lon: -79.94,
        condition: 'Clean',
        ...override
      };
      await expect(
        NotificationModel.submitReport(
          'member-id',
          data as Parameters<typeof NotificationModel.submitReport>[1]
        )
      ).rejects.toMatchObject({ name: 'InvalidReportField' });
      expect(lookup).not.toHaveBeenCalled();
    }
  );
  test('database reset refuses implicit development destruction before connecting', async () => {
    const previous = process.env.ALLOW_DB_RESET;
    delete process.env.ALLOW_DB_RESET;
    const db = new MongoDB('mongodb://unused/not-connected');
    const connect = jest.spyOn(db, 'connect');
    try {
      await expect(db.init()).rejects.toThrow('ALLOW_DB_RESET');
      expect(connect).not.toHaveBeenCalled();
    } finally {
      process.env.ALLOW_DB_RESET = previous;
    }
  });
});
