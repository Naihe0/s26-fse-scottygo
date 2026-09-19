import type { RequestHandler } from 'express';

type Bucket = { count: number; expiresAt: number };

/** A bounded, process-local abuse limit. Never reads forwarded headers directly. */
export function createIpRateLimiter(options: {
  limit: number;
  windowMs: number;
  maxEntries?: number;
  skipSuccessful?: boolean;
  now?: () => number;
}): { middleware: RequestHandler; reset: () => void; size: () => number } {
  const buckets = new Map<string, Bucket>();
  const now = options.now ?? Date.now;
  const capacity = options.maxEntries ?? 10_000;
  let nextCleanupAt = 0;

  const middleware: RequestHandler = (req, res, next) => {
    const time = now();
    if (time >= nextCleanupAt) {
      for (const [key, bucket] of buckets) {
        if (bucket.expiresAt <= time) buckets.delete(key);
      }
      nextCleanupAt = time + Math.min(options.windowMs, 60_000);
    }
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    let bucket = buckets.get(key);
    if (bucket && bucket.expiresAt <= time) {
      buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (buckets.size >= capacity) {
        // Bound memory without evicting active limits (which would allow bypass).
        res.setHeader(
          'Retry-After',
          Math.max(1, Math.ceil((nextCleanupAt - time) / 1000))
        );
        res.status(429).json({
          type: 'ClientError',
          name: 'UnauthorizedRequest',
          message: 'Too many authentication requests. Please try again later.'
        });
        return;
      }
      bucket = { count: 0, expiresAt: time + options.windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= options.limit) {
      res.setHeader(
        'Retry-After',
        Math.max(1, Math.ceil((bucket.expiresAt - time) / 1000))
      );
      res.status(429).json({
        type: 'ClientError',
        name: 'UnauthorizedRequest',
        message: 'Too many authentication requests. Please try again later.'
      });
      return;
    }
    bucket.count += 1;
    if (options.skipSuccessful) {
      const admittedBucket = bucket;
      res.once('finish', () => {
        if (res.statusCode < 400 && buckets.get(key) === admittedBucket) {
          admittedBucket.count = Math.max(0, admittedBucket.count - 1);
        }
      });
    }
    next();
  };
  return {
    middleware,
    reset: () => {
      buckets.clear();
      nextCleanupAt = 0;
    },
    size: () => buckets.size
  };
}
