import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import AuthController from '../../../server/controllers/auth.controller';
import MapController from '../../../server/controllers/map.controller';
import { User } from '../../../server/models/user.model';
import { IAppError } from '../../../common/server.responses';
import {
  ITokenPayload,
  IUser,
  IUserAccount
} from '../../../common/user.interface';
import { JWT_KEY as secretKey } from '../../../server/env';

type MockResponse = Partial<Response> & {
  status: jest.Mock;
  json: jest.Mock;
  location: jest.Mock;
};

const createMockResponse = (): MockResponse => {
  const res: MockResponse = {
    status: jest.fn(),
    json: jest.fn(),
    location: jest.fn()
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.location.mockReturnValue(res);
  return res;
};

describe('LoginLogout Use Case unit tests', () => {
  const authController = AuthController.getInstance('/auth');
  const mapController = MapController.getInstance('/');

  const activeAgreedUser: IUser = {
    _id: 'user-id-1',
    credentials: {
      username: 'member1',
      password: 'hashed-password'
    },
    email: 'member1@example.com',
    agreed: true
  };

  const activeAccount: IUserAccount = {
    ...activeAgreedUser,
    status: 'Active',
    privilegeLevel: 'Member',
    onboardingComplete: false
  };

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  // Successful login test 1
  test('login succeeds with valid username and password', async () => {
    const req = {
      params: { username: 'member1' },
      body: { password: 'CorrectPassword123!' }
    } as unknown as Request;
    const res = createMockResponse();

    jest.spyOn(User, 'validateUser').mockResolvedValue(activeAgreedUser);
    jest.spyOn(User, 'getUserAccount').mockResolvedValue(activeAccount);

    await authController.login(req, res as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'UserAuthenticated',
        payload: expect.objectContaining({
          token: expect.any(String),
          user: expect.objectContaining({
            credentials: expect.objectContaining({
              username: 'member1',
              password: 'obfuscated'
            })
          })
        })
      })
    );

    const responseBody = res.json.mock.calls[0][0] as {
      payload: { token: string };
    };
    const decoded = jwt.verify(
      responseBody.payload.token,
      secretKey
    ) as ITokenPayload;
    expect(decoded.userId).toBe(activeAgreedUser._id);
    expect(decoded.username).toBe(activeAgreedUser.credentials.username);
  });

  // Unsuccessful login test 1 - username missing
  test('login fails when username is missing', async () => {
    const req = {
      params: {},
      body: { password: 'CorrectPassword123!' }
    } as unknown as Request;
    const res = createMockResponse();

    await authController.login(req, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'MissingUsername'
      })
    );
  });

  // Unsuccessful login test 2 - password missing
  test('login fails when password is missing', async () => {
    const req = {
      params: { username: 'member1' },
      body: {}
    } as unknown as Request;
    const res = createMockResponse();

    await authController.login(req, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'MissingPassword'
      })
    );
  });

  // Unsuccessful login test 3 - password incorrect
  test('login fails when password invalid', async () => {
    const req = {
      params: { username: 'member1' },
      body: { password: 'WrongPassword123!' }
    } as unknown as Request;
    const res = createMockResponse();

    const invalidCredsError: IAppError = {
      type: 'ClientError',
      name: 'IncorrectPassword',
      message: 'Incorrect password'
    };

    jest.spyOn(User, 'getUserAccount').mockResolvedValue(activeAccount);
    jest.spyOn(User, 'validateUser').mockRejectedValue(invalidCredsError);

    await authController.login(req, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(invalidCredsError);
  });

  // Successful logout test
  test('logout succeeds by removing token and then failing authorization', async () => {
    const req = {
      headers: {},
      body: {}
    } as unknown as Request;
    const res = createMockResponse();
    const next = jest.fn() as NextFunction;

    await mapController.authenticateToken(req, res as Response, next);

    // This represents post-logout behavior: token is absent, access is denied.
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'MissingToken'
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  // Test generation and validation of token WITHOUT expiry
  test('generates and validates token without expiry', () => {
    const payload: ITokenPayload = {
      userId: 'user-id-2',
      username: 'member2'
    };

    const token = jwt.sign(payload, secretKey);
    const decoded = jwt.verify(token, secretKey) as ITokenPayload;

    expect(decoded.userId).toBe(payload.userId);
    expect(decoded.username).toBe(payload.username);
    expect(decoded.exp).toBeUndefined();
  });

  // Test generation and validation of token WITH expiry
  test('generates and validates token with expiry', () => {
    const payload: ITokenPayload = {
      userId: 'user-id-3',
      username: 'member3'
    };

    const token = jwt.sign(payload, secretKey, { expiresIn: '1h' });
    const decoded = jwt.verify(token, secretKey) as ITokenPayload;

    expect(decoded.userId).toBe(payload.userId);
    expect(decoded.username).toBe(payload.username);
    expect(decoded.exp).toBeDefined();
    expect(decoded.iat).toBeDefined();
    expect((decoded.exp as number) > (decoded.iat as number)).toBe(true);
  });

  // Unsuccessful logout test - token expired
  test('fails validation for expired token', () => {
    const payload: ITokenPayload = {
      userId: 'user-id-4',
      username: 'member4'
    };

    const token = jwt.sign(payload, secretKey, { expiresIn: '1s' });

    expect(() => {
      jwt.verify(token, secretKey, {
        clockTimestamp: Math.floor(Date.now() / 1000) + 2
      });
    }).toThrow('jwt expired');
  });
});
