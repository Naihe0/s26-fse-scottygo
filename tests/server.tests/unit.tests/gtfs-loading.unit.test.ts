import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import fsPromises from 'fs/promises';
import { GTFSService } from '../../../server/services/gtfs.service';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

const tables: Record<string, string> = {
  'routes.txt':
    'route_id,route_short_name,route_long_name,route_color\n61C,61C,Test route,C41230\n',
  'stops.txt':
    'stop_id,stop_name,stop_lat,stop_lon\n1,First,40.44,-79.94\n2,Last,40.45,-79.93\n',
  'shapes.txt':
    'shape_id,shape_pt_sequence,shape_pt_lat,shape_pt_lon\nshape,2,40.45,-79.93\nshape,1,40.44,-79.94\n',
  'trips.txt':
    'trip_id,route_id,service_id,direction_id,shape_id,trip_headsign\ntrip,61C,daily,0,shape,Downtown\n',
  'calendar.txt':
    'service_id,sunday,monday,tuesday,wednesday,thursday,friday,saturday,start_date,end_date\ndaily,1,1,1,1,1,1,1,20260101,20261231\n',
  'calendar_dates.txt': 'service_id,date,exception_type\ndaily,20260920,2\n',
  'stop_times.txt':
    'trip_id,departure_time,stop_id\ntrip,08:00:00,1\ntrip,08:30:00,2\n'
};

function unzipChild(content: string, exitCode = 0) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null as number | null,
    kill: jest.fn()
  });
  child.kill.mockImplementation(() => {
    if (child.exitCode === null) {
      child.exitCode = 1;
      child.stdout.destroy();
      child.stderr.end();
      child.emit('close', 1);
    }
    return true;
  });
  // Match child-process scheduling: listeners are attached before output arrives.
  setImmediate(() => {
    child.stdout.end(content);
    child.stderr.end(exitCode ? 'fixture unzip failure' : '');
    child.exitCode = exitCode;
    child.emit('close', exitCode);
  });
  return child;
}

describe('bounded streaming GTFS startup', () => {
  let fetchMock: jest.SpyInstance;
  const spawnMock = jest.mocked(spawn);

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('fixture archive'));
    spawnMock.mockReset().mockImplementation((_command, args) => {
      const filename = args![2];
      return unzipChild(tables[filename]) as unknown as ReturnType<
        typeof spawn
      >;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('streams every table and preserves sorted geometry, calendars, direction, and schedules', async () => {
    const service = new GTFSService();
    await service.load();

    expect(service.isLoaded()).toBe(true);
    expect(service.getRoutes()).toEqual([
      expect.objectContaining({ id: '61C', color: '#C41230' })
    ]);
    expect(service.getPatterns('61C')).toEqual([
      {
        direction: 'OUTBOUND',
        shapeId: 'shape',
        path: [
          { lat: 40.44, lng: -79.94 },
          { lat: 40.45, lng: -79.93 }
        ]
      }
    ]);
    expect(
      service.getStopsByDirection('61C', 'OUTBOUND').map((stop) => stop.stopId)
    ).toEqual(['1', '2']);
    expect(service.getTripDirection('trip')).toBe('OUTBOUND');
    expect(service.getTripShapeId('trip')).toBe('shape');
    expect(service.getTripShapeId('unknown')).toBeUndefined();
    expect(service.filterRoutesByDate(new Date(2026, 8, 19))).toHaveLength(1);
    expect(service.filterRoutesByDate(new Date(2026, 8, 20))).toHaveLength(0);
    expect(service.getRouteSchedule('61C')?.directions).toEqual([
      {
        direction: 'OUTBOUND',
        firstTrip: '08:00',
        lastTrip: '08:30',
        headsign: 'Downtown'
      }
    ]);
    expect(spawnMock.mock.calls.map((call) => call[1]![2])).toEqual(
      Object.keys(tables)
    );
    await expect(
      fsPromises.stat(spawnMock.mock.calls[0][1]![1])
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('concurrent callers share one download and parsing run', async () => {
    const service = new GTFSService();
    await Promise.all([service.load(), service.load()]);
    await service.load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(7);
  });

  test('retries a failed HTTP download and then loads normally', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('unavailable', { status: 503 })
    );
    const service = new GTFSService();
    await service.load();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(service.isLoaded()).toBe(true);
  });

  test('rejects a nonzero unzip exit even after valid CSV output and clears partial data before retry', async () => {
    spawnMock.mockImplementation((_command, args) => {
      const filename = args![2];
      const firstAttempt = fetchMock.mock.calls.length === 1;
      const content =
        firstAttempt && filename === 'routes.txt'
          ? tables[filename].replaceAll('61C', 'partial-route')
          : tables[filename];
      return unzipChild(
        content,
        firstAttempt && filename === 'stops.txt' ? 2 : 0
      ) as unknown as ReturnType<typeof spawn>;
    });
    const service = new GTFSService();
    await service.load();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(service.getRoutes().map((route) => route.id)).toEqual(['61C']);
  });

  test('download deadlines abort stalled requests and stop after three attempts', async () => {
    jest.useFakeTimers();
    // No file was created because fetch never returns; avoid mixing real disk I/O with virtual time.
    jest.spyOn(fsPromises, 'unlink').mockResolvedValue(undefined);
    fetchMock.mockImplementation(
      (_url, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    const service = new GTFSService();
    const failure = service.load().catch((error) => error);
    await jest.advanceTimersByTimeAsync(365_000);
    expect(await failure).toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(service.isLoaded()).toBe(false);
    expect(service.getRoutes()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a stuck unzip process is killed on the table deadline and cannot leave partial data ready', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.spyOn(fsPromises, 'unlink').mockResolvedValue(undefined);
    const children: ReturnType<typeof unzipChild>[] = [];
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        exitCode: null as number | null,
        kill: jest.fn()
      });
      child.kill.mockImplementation(() => {
        child.exitCode = 1;
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 1);
        return true;
      });
      children.push(child);
      return child as unknown as ReturnType<typeof spawn>;
    });
    const service = new GTFSService();
    jest
      .spyOn(
        service as unknown as { downloadFeed(): Promise<string> },
        'downloadFeed'
      )
      .mockResolvedValue('unused-fixture.zip');
    const failure = service.load().catch((error) => error);
    await jest.advanceTimersByTimeAsync(905_000);
    expect(await failure).toBeInstanceOf(Error);
    expect(children).toHaveLength(3);
    for (const child of children) expect(child.kill).toHaveBeenCalled();
    expect(service.isLoaded()).toBe(false);
    expect(service.getRoutes()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });
});
