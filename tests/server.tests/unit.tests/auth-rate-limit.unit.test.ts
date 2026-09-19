import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createIpRateLimiter } from '../../../server/services/auth-rate-limit.service';

const response = () => {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 400,
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn()
  });
  res.status.mockReturnValue(res);
  return res;
};
const request = (ip = '192.0.2.1') => ({ ip, socket: {} }) as Request;

test('failure budget returns generic 429 with Retry-After and separates IPs', () => {
  const limit = createIpRateLimiter({
    limit: 2,
    windowMs: 60_000,
    now: () => 0
  });
  const next = jest.fn();
  const res = response();
  limit.middleware(request(), res as unknown as Response, next);
  limit.middleware(request(), res as unknown as Response, next);
  limit.middleware(request(), res as unknown as Response, next);
  expect(next).toHaveBeenCalledTimes(2);
  expect(res.status).toHaveBeenCalledWith(429);
  expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 60);
  expect(res.json).toHaveBeenCalledWith({
    type: 'ClientError',
    name: 'UnauthorizedRequest',
    message: 'Too many authentication requests. Please try again later.'
  });
  limit.middleware(
    request('192.0.2.2'),
    response() as unknown as Response,
    next
  );
  expect(next).toHaveBeenCalledTimes(3);
});

test('successful logins do not exhaust the failure budget; pending attempts count', () => {
  const limit = createIpRateLimiter({
    limit: 1,
    windowMs: 60_000,
    skipSuccessful: true
  });
  const next = jest.fn();
  const successful = response();
  successful.statusCode = 200;
  limit.middleware(request(), successful as unknown as Response, next);
  const pending = response();
  limit.middleware(request(), pending as unknown as Response, next);
  expect(pending.status).toHaveBeenCalledWith(429);
  successful.emit('finish');
  limit.middleware(request(), response() as unknown as Response, next);
  expect(next).toHaveBeenCalledTimes(2);
});

test('expired entries are removed, memory is bounded, and active limits are not evicted', () => {
  let now = 0;
  const limit = createIpRateLimiter({
    limit: 1,
    windowMs: 1000,
    maxEntries: 2,
    now: () => now
  });
  const next = jest.fn();
  limit.middleware(request('a'), response() as unknown as Response, next);
  limit.middleware(request('b'), response() as unknown as Response, next);
  const overflow = response();
  limit.middleware(request('c'), overflow as unknown as Response, next);
  expect(overflow.status).toHaveBeenCalledWith(429);
  expect(limit.size()).toBe(2);
  const original = response();
  limit.middleware(request('a'), original as unknown as Response, next);
  expect(original.status).toHaveBeenCalledWith(429);
  now = 1000;
  limit.middleware(request('c'), response() as unknown as Response, next);
  expect(limit.size()).toBe(1);
  expect(next).toHaveBeenCalledTimes(3);
  limit.reset();
  expect(limit.size()).toBe(0);
});

test('late success from an expired window cannot decrement its replacement bucket', () => {
  let now = 0;
  const limit = createIpRateLimiter({
    limit: 1,
    windowMs: 1000,
    skipSuccessful: true,
    now: () => now
  });
  const next = jest.fn();
  const first = response();
  first.statusCode = 200;
  limit.middleware(request(), first as unknown as Response, next);
  now = 1001;
  limit.middleware(request(), response() as unknown as Response, next);
  first.emit('finish');
  const final = response();
  limit.middleware(request(), final as unknown as Response, next);
  expect(final.status).toHaveBeenCalledWith(429);
});

test('one trusted proxy ignores spoofed leftmost forwarded IPs; local mode ignores all forwarding', async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.get(
    '/',
    createIpRateLimiter({ limit: 1, windowMs: 60_000 }).middleware,
    (_req, res) => res.sendStatus(200)
  );
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    expect(
      (
        await fetch(url, {
          headers: { 'X-Forwarded-For': '198.51.100.1, 192.0.2.10' }
        })
      ).status
    ).toBe(200);
    expect(
      (
        await fetch(url, {
          headers: { 'X-Forwarded-For': '198.51.100.2, 192.0.2.10' }
        })
      ).status
    ).toBe(429);
    app.set('trust proxy', false);
    expect(
      (await fetch(url, { headers: { 'X-Forwarded-For': '192.0.2.11' } }))
        .status
    ).toBe(200);
    expect(
      (await fetch(url, { headers: { 'X-Forwarded-For': '192.0.2.12' } }))
        .status
    ).toBe(429);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
