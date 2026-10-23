import express from 'express';
import path from 'path';
import { AddressInfo } from 'net';
import { Server as HttpServer } from 'http';
import Controller from '../../../server/controllers/controller';
import TransitController from '../../../server/controllers/transit.controller';
import HealthController from '../../../server/controllers/health.controller';
import DAC from '../../../server/db/dac';

describe('REST smoke: memory monitoring endpoints', () => {
  let server: HttpServer;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();

    const now = new Date();
    const samples = [
      {
        timestamp: new Date(now.getTime() - 30_000),
        reason: 'interval',
        rssMb: 128,
        heapUsedMb: 64,
        heapTotalMb: 96,
        externalMb: 11,
        arrayBuffersMb: 5,
        uptimeSec: 100,
        peakRssMb: 140,
        peakHeapUsedMb: 70,
        warning: false,
        critical: false
      },
      {
        timestamp: now,
        reason: 'interval',
        rssMb: 142,
        heapUsedMb: 72,
        heapTotalMb: 100,
        externalMb: 12,
        arrayBuffersMb: 6,
        uptimeSec: 130,
        peakRssMb: 150,
        peakHeapUsedMb: 75,
        warning: true,
        critical: false
      }
    ];

    DAC.db = {
      getRecentMemorySamples: jest.fn().mockResolvedValue(samples)
    } as never;

    // Serve page sources so this suite does not depend on a client build.
    Controller.clientDir = path.join(__dirname, '../../../client/pages');
    const transit = TransitController.getInstance('/transit');
    const health = HealthController.getInstance('/transit');
    app.use('/transit', transit.router);
    app.use('/transit', health.router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('GET /transit/memory/samples returns expected payload', async () => {
    const res = await fetch(`${baseUrl}/transit/memory/samples?limit=5`);
    const body = (await res.json()) as {
      name: string;
      payload: unknown[];
    };

    expect(res.status).toBe(200);
    expect(body.name).toBe('MemorySamplesRetrieved');
    expect(Array.isArray(body.payload)).toBe(true);
    expect(body.payload.length).toBeGreaterThan(0);
  });

  test('GET /transit/memory/summary returns analyzed summary', async () => {
    const res = await fetch(`${baseUrl}/transit/memory/summary?limit=10`);
    const body = (await res.json()) as {
      name: string;
      payload: {
        sampleCount: number;
        rss?: { latestMb?: number; maxMb?: number };
        heap?: { latestUsedMb?: number };
      };
    };

    expect(res.status).toBe(200);
    expect(body.name).toBe('MemorySummaryRetrieved');
    expect(body.payload.sampleCount).toBeGreaterThan(0);
    expect(typeof body.payload.rss?.latestMb).toBe('number');
    expect(typeof body.payload.rss?.maxMb).toBe('number');
    expect(typeof body.payload.heap?.latestUsedMb).toBe('number');
  });

  test('GET /transit/memory/dashboard returns html', async () => {
    const res = await fetch(`${baseUrl}/transit/memory/dashboard`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain(
      'text/html'
    );
    expect(html).toContain('ScottyGo Memory Dashboard');
    expect(html).toContain('id="chart"');
    expect(html).toContain('id="metrics"');
  });

  test('GET /transit/health includes memory section', async () => {
    const res = await fetch(`${baseUrl}/transit/health`);
    const body = (await res.json()) as {
      memory?: unknown;
      overall?: boolean;
    };

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('memory');
    expect(typeof body.overall).toBe('boolean');
  });
});
