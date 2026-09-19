import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoDB } from '../../../server/db/mongo.db';
import type { ISubscription } from '../../../common/transit.interface';

// Jest's setup-env validates this as a dedicated loopback-only test database.
const db = new MongoDB(process.env.TEST_DB_URL!);
const userIds: string[] = [];
const newUserId = () => {
  const id = `subscription-concurrency-${randomUUID()}`;
  userIds.push(id);
  return id;
};
const sub = (userId: string, routeId: string): ISubscription => ({
  _id: randomUUID(),
  userId,
  routeId,
  createdAt: new Date().toISOString()
});

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await mongoose.model('SubscriptionSet').deleteMany({ _id: { $in: userIds } });
  await mongoose.model('Subscription').deleteMany({ userId: { $in: userIds } });
  await db.close();
});

test('parallel distinct adds never exceed ten persisted routes', async () => {
  const userId = newUserId();
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      db.saveSubscription(sub(userId, `route-${i}`))
    )
  );
  expect(
    results.filter((result) => result.status === 'fulfilled')
  ).toHaveLength(10);
  const rejected = results.filter(
    (result) => result.status === 'rejected'
  ) as PromiseRejectedResult[];
  expect(rejected).toHaveLength(10);
  rejected.forEach((result) =>
    expect(result.reason).toMatchObject({ name: 'SubscriptionLimitReached' })
  );
  const stored = await db.getSubscriptionsByUserId(userId);
  expect(stored).toHaveLength(10);
  expect(new Set(stored.map((item) => item.routeId)).size).toBe(10);
});

test('concurrent duplicate adds persist one subscription and return consistent conflicts', async () => {
  const userId = newUserId();
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => db.saveSubscription(sub(userId, '61C')))
  );
  expect(
    results.filter((result) => result.status === 'fulfilled')
  ).toHaveLength(1);
  const rejected = results.filter(
    (result) => result.status === 'rejected'
  ) as PromiseRejectedResult[];
  rejected.forEach((result) =>
    expect(result.reason).toMatchObject({ name: 'DuplicateSubscription' })
  );
  expect(await db.countSubscriptionsByUserId(userId)).toBe(1);
});

test('deletion frees exactly one slot for competing adds', async () => {
  const userId = newUserId();
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      db.saveSubscription(sub(userId, `old-${i}`))
    )
  );
  expect(await db.deleteSubscription(userId, 'old-0')).toBe(true);
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      db.saveSubscription(sub(userId, `new-${i}`))
    )
  );
  expect(
    results.filter((result) => result.status === 'fulfilled')
  ).toHaveLength(1);
  expect(await db.countSubscriptionsByUserId(userId)).toBe(10);
});

test('concurrent first reads preserve legacy subscriptions; removal never reimports them', async () => {
  const userId = newUserId();
  const legacy = [sub(userId, '61C'), sub(userId, 'P1')];
  await mongoose.model('Subscription').insertMany(legacy);
  const snapshots = await Promise.all(
    Array.from({ length: 10 }, () => db.getSubscriptionsByUserId(userId))
  );
  snapshots.forEach((snapshot) =>
    expect(snapshot.map((item) => item.routeId).sort()).toEqual(['61C', 'P1'])
  );
  expect(await db.deleteSubscription(userId, '61C')).toBe(true);
  expect(await db.findSubscription(userId, '61C')).toBeNull();
  expect(await db.countSubscriptionsByUserId(userId)).toBe(1);
  expect(await mongoose.model('Subscription').countDocuments({ userId })).toBe(
    2
  );
});
