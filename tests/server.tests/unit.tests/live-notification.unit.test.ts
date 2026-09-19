// Unit tests for TUC3 — Live Notification
// Tests NotificationModel business logic: subscriptions (R1, R2),
// bus report validation (R5, R9), proximity check (R9/R10),
// status-change detection (R6, R12), LLM moderation (R11),
// notification construction (R6), and search (R3).

import { NotificationModel } from '../../../server/models/notification.model';
import { TransitModel } from '../../../server/models/transit.model';
import DAC, { IDatabase } from '../../../server/db/dac';
import vehiclePositionsService from '../../../server/services/vehicle-positions.service';
import moderationService from '../../../server/services/moderation.service';
import {
  ISubscription,
  IBusReport,
  INotification,
  IRoute,
  IVehicle
} from '../../../common/transit.interface';

// ============================================================================
// Test helpers
// ============================================================================

function createMockDb(overrides: Partial<IDatabase> = {}): IDatabase {
  return {
    connect: jest.fn(),
    init: jest.fn(),
    close: jest.fn(),
    saveUser: jest.fn(),
    findUserByUsername: jest.fn(),
    findUserById: jest.fn(),
    setUserAgreedToTrue: jest.fn(),
    findUserAccountByUsername: jest.fn(),
    findUserAccountById: jest.fn(),
    updateUserStatus: jest.fn(),
    updateUserPrivilege: jest.fn(),
    updateUsername: jest.fn(),
    updateUserEmail: jest.fn(),
    updateUserPassword: jest.fn(),
    countAdministrators: jest.fn(),
    getAllUsernames: jest.fn(),
    getAllUserAccounts: jest.fn(),
    seedDefaultAdmin: jest.fn(),
    getTransitCache: jest.fn(),
    getAllTransitCaches: jest.fn(),
    upsertTransitCache: jest.fn(),
    clearTransitCache: jest.fn(),
    saveMemorySample: jest.fn(),
    getRecentMemorySamples: jest.fn(),
    getSubscriptionsByUserId: jest.fn(),
    findSubscription: jest.fn(),
    countSubscriptionsByUserId: jest.fn(),
    saveSubscription: jest.fn(),
    deleteSubscription: jest.fn(),
    saveBusReport: jest.fn(),
    getLatestReportByVehicle: jest.fn(),
    saveNotification: jest.fn(),
    getRecentNotifications: jest.fn(),
    ...overrides
  };
}

/** Sample route for TransitModel mock. */
const sampleRoute: IRoute = {
  id: '61C',
  name: 'McKeesport-Homestead-Pittsburgh',
  system: 'PRT',
  color: '#00AA00',
  directions: ['INBOUND', 'OUTBOUND'],
  activeStatus: true,
  operatingDays: [1, 2, 3, 4, 5]
};

/** Sample vehicle near downtown Pittsburgh. */
const sampleVehicle: IVehicle = {
  vid: 'V100',
  lat: 40.4406,
  lon: -79.9959,
  routeId: '61C',
  heading: 180,
  source: 'live',
  lastUpdate: new Date().toISOString(),
  isDetoured: false
};

/** User coordinates close to the sample vehicle (within 0.5 miles). */
const nearbyCoords = { lat: 40.441, lon: -79.996 };

/** User coordinates far from the sample vehicle (> 0.5 miles). */
const farCoords = { lat: 40.5, lon: -80.1 };

// ============================================================================
// Reset internal state between tests
// ============================================================================

function resetLastKnownStatus(): void {
  // Access private static map via bracket notation to reset between tests
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (NotificationModel as any).lastKnownStatus = new Map();
}

// ============================================================================
// Subscription Business Rules (R1, R2)
// ============================================================================

describe('Subscription rules', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('subscription is created for a valid route', async () => {
    jest.spyOn(TransitModel, 'getRoutes').mockResolvedValue([sampleRoute]);

    const savedSub: ISubscription = {
      _id: 'sub-1',
      userId: 'user-1',
      routeId: '61C',
      createdAt: new Date().toISOString()
    };

    DAC.db = createMockDb({
      findSubscription: jest.fn().mockResolvedValue(null),
      countSubscriptionsByUserId: jest.fn().mockResolvedValue(0),
      saveSubscription: jest.fn().mockResolvedValue(savedSub)
    });

    const result = await NotificationModel.subscribe('user-1', '61C');

    expect(result.routeId).toBe('61C');
    expect(result.userId).toBe('user-1');
    expect(result._id).toBeDefined();
  });

  test('(negative) duplicate subscription is rejected', async () => {
    jest.spyOn(TransitModel, 'getRoutes').mockResolvedValue([sampleRoute]);

    DAC.db = createMockDb({
      saveSubscription: jest.fn().mockRejectedValue({
        type: 'ClientError',
        name: 'DuplicateSubscription'
      })
    });

    await expect(
      NotificationModel.subscribe('user-1', '61C')
    ).rejects.toMatchObject({
      type: 'ClientError',
      name: 'DuplicateSubscription'
    });
  });

  test('(negative) subscription limit of 10 is enforced', async () => {
    jest.spyOn(TransitModel, 'getRoutes').mockResolvedValue([sampleRoute]);

    DAC.db = createMockDb({
      saveSubscription: jest.fn().mockRejectedValue({
        type: 'ClientError',
        name: 'SubscriptionLimitReached',
        message: 'Subscription limit reached (10).'
      })
    });

    await expect(
      NotificationModel.subscribe('user-1', '61C')
    ).rejects.toMatchObject({
      type: 'ClientError',
      name: 'SubscriptionLimitReached',
      message: expect.stringContaining('10')
    });
  });

  test('(negative) subscribing to a non-existent route is rejected', async () => {
    jest.spyOn(TransitModel, 'getRoutes').mockResolvedValue([sampleRoute]);

    DAC.db = createMockDb();

    await expect(
      NotificationModel.subscribe('user-1', 'FAKE_ROUTE')
    ).rejects.toMatchObject({
      type: 'ClientError',
      name: 'RouteNotFound'
    });
  });

  test('(negative) unsubscribing from a route not subscribed to is rejected', async () => {
    DAC.db = createMockDb({
      deleteSubscription: jest.fn().mockResolvedValue(false)
    });

    await expect(
      NotificationModel.unsubscribe('user-1', '61C')
    ).rejects.toMatchObject({
      type: 'ClientError',
      name: 'SubscriptionNotFound'
    });
  });
});

// ============================================================================
// Bus Report Validation (R5, R9, R10, R11)
// ============================================================================

describe('Bus report validation', () => {
  beforeEach(() => {
    resetLastKnownStatus();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('(negative) report with no answers is rejected', async () => {
    DAC.db = createMockDb();

    await expect(
      NotificationModel.submitReport('user-1', {
        vid: 'V100',
        routeId: '61C',
        lat: nearbyCoords.lat,
        lon: nearbyCoords.lon
      })
    ).rejects.toMatchObject({
      type: 'ClientError',
      name: 'EmptyReport'
    });
  });

  test('(negative) report with missing required fields is rejected', async () => {
    DAC.db = createMockDb();

    await expect(
      NotificationModel.submitReport('user-1', {
        vid: '',
        routeId: '61C',
        crowdedness: 'Packed',
        lat: nearbyCoords.lat,
        lon: nearbyCoords.lon
      })
    ).rejects.toMatchObject({
      type: 'ClientError',
      name: 'MissingParameter'
    });
  });

  test('(negative) report with invalid crowdedness value is rejected', async () => {
    jest
      .spyOn(vehiclePositionsService, 'getVehicles')
      .mockReturnValue([sampleVehicle]);

    DAC.db = createMockDb();

    await expect(
      NotificationModel.submitReport('user-1', {
        vid: 'V100',
        routeId: '61C',
        crowdedness: 'Super Packed',
        lat: nearbyCoords.lat,
        lon: nearbyCoords.lon
      })
    ).rejects.toMatchObject({
      type: 'ClientError',
      name: 'InvalidReportField'
    });
  });

  test('(negative) report with invalid condition value is rejected', async () => {
    jest
      .spyOn(vehiclePositionsService, 'getVehicles')
      .mockReturnValue([sampleVehicle]);

    DAC.db = createMockDb();

    await expect(
      NotificationModel.submitReport('user-1', {
        vid: 'V100',
        routeId: '61C',
        condition: 'Terrible',
        lat: nearbyCoords.lat,
        lon: nearbyCoords.lon
      })
    ).rejects.toMatchObject({
      type: 'ClientError',
      name: 'InvalidReportField'
    });
  });
});

// ============================================================================
// Proximity Rule (R9)
// ============================================================================

describe('Proximity validation (R9)', () => {
  beforeEach(() => {
    resetLastKnownStatus();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('(negative) report from a user too far from the bus is rejected', async () => {
    jest
      .spyOn(vehiclePositionsService, 'getVehicles')
      .mockReturnValue([sampleVehicle]);

    DAC.db = createMockDb();

    await expect(
      NotificationModel.submitReport('user-1', {
        vid: 'V100',
        routeId: '61C',
        crowdedness: 'Packed',
        lat: farCoords.lat,
        lon: farCoords.lon
      })
    ).rejects.toMatchObject({
      type: 'ClientError',
      name: 'ProximityViolation'
    });
  });

  test('(negative) report for a vehicle not found on the route is rejected', async () => {
    jest.spyOn(vehiclePositionsService, 'getVehicles').mockReturnValue([]);

    DAC.db = createMockDb();

    await expect(
      NotificationModel.submitReport('user-1', {
        vid: 'V999',
        routeId: '61C',
        crowdedness: 'Empty',
        lat: nearbyCoords.lat,
        lon: nearbyCoords.lon
      })
    ).rejects.toMatchObject({
      type: 'ClientError',
      name: 'VehicleNotFound'
    });
  });

  test('proximity check is bypassed when bypassProximityCheck is true', async () => {
    jest
      .spyOn(vehiclePositionsService, 'getVehicles')
      .mockReturnValue([sampleVehicle]);
    jest
      .spyOn(moderationService, 'moderate')
      .mockResolvedValue({ flagged: false });

    const savedReport: IBusReport = {
      _id: 'rpt-1',
      userId: 'admin-1',
      vid: 'V100',
      routeId: '61C',
      crowdedness: 'Empty',
      lat: farCoords.lat,
      lon: farCoords.lon,
      createdAt: new Date().toISOString()
    };

    const savedNotification: INotification = {
      _id: 'notif-1',
      routeId: '61C',
      vid: 'V100',
      message: 'Bus #V100 on Route 61C — Crowdedness changed to Empty',
      changedFields: ['crowdedness'],
      reportId: 'rpt-1',
      createdAt: new Date().toISOString()
    };

    DAC.db = createMockDb({
      saveBusReport: jest.fn().mockResolvedValue(savedReport),
      saveNotification: jest.fn().mockResolvedValue(savedNotification)
    });

    // Admin submitting from far away with bypass flag
    const result = await NotificationModel.submitReport('admin-1', {
      vid: 'V100',
      routeId: '61C',
      crowdedness: 'Empty',
      lat: farCoords.lat,
      lon: farCoords.lon,
      bypassProximityCheck: true
    });

    expect(result.report.crowdedness).toBe('Empty');
    expect(result.notification).not.toBeNull();
  });
});

// ============================================================================
// Status Change Detection & Notification Construction (R6, R12)
// ============================================================================

describe('Status change detection and notification (R6, R12)', () => {
  beforeEach(() => {
    resetLastKnownStatus();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('first report for a bus triggers a notification with all reported fields', async () => {
    jest
      .spyOn(vehiclePositionsService, 'getVehicles')
      .mockReturnValue([sampleVehicle]);
    jest
      .spyOn(moderationService, 'moderate')
      .mockResolvedValue({ flagged: false });

    const savedReport: IBusReport = {
      _id: 'rpt-2',
      userId: 'user-1',
      vid: 'V100',
      routeId: '61C',
      crowdedness: 'Packed',
      condition: 'Dirty',
      lat: nearbyCoords.lat,
      lon: nearbyCoords.lon,
      createdAt: new Date().toISOString()
    };

    DAC.db = createMockDb({
      saveBusReport: jest.fn().mockResolvedValue(savedReport),
      saveNotification: jest
        .fn()
        .mockImplementation((n: INotification) =>
          Promise.resolve({ ...n, _id: 'notif-2' })
        )
    });

    const result = await NotificationModel.submitReport('user-1', {
      vid: 'V100',
      routeId: '61C',
      crowdedness: 'Packed',
      condition: 'Dirty',
      lat: nearbyCoords.lat,
      lon: nearbyCoords.lon
    });

    expect(result.notification).not.toBeNull();
    expect(result.notification!.changedFields).toContain('crowdedness');
    expect(result.notification!.changedFields).toContain('condition');
    expect(result.notification!.message).toContain(
      'Crowdedness changed to Packed'
    );
    expect(result.notification!.message).toContain(
      'Condition changed to Dirty'
    );
  });

  test('report with same status as last known does not produce a notification', async () => {
    jest
      .spyOn(vehiclePositionsService, 'getVehicles')
      .mockReturnValue([sampleVehicle]);
    jest
      .spyOn(moderationService, 'moderate')
      .mockResolvedValue({ flagged: false });

    const savedReport: IBusReport = {
      _id: 'rpt-3',
      userId: 'user-1',
      vid: 'V100',
      routeId: '61C',
      crowdedness: 'Packed',
      lat: nearbyCoords.lat,
      lon: nearbyCoords.lon,
      createdAt: new Date().toISOString()
    };

    DAC.db = createMockDb({
      saveBusReport: jest.fn().mockResolvedValue(savedReport),
      saveNotification: jest.fn()
    });

    // First report sets the status
    await NotificationModel.submitReport('user-1', {
      vid: 'V100',
      routeId: '61C',
      crowdedness: 'Packed',
      lat: nearbyCoords.lat,
      lon: nearbyCoords.lon
    });

    // Second report with the same crowdedness
    const result = await NotificationModel.submitReport('user-2', {
      vid: 'V100',
      routeId: '61C',
      crowdedness: 'Packed',
      lat: nearbyCoords.lat,
      lon: nearbyCoords.lon
    });

    expect(result.notification).toBeNull();
    // saveBusReport called for both, saveNotification only for the first
    expect(DAC.db.saveBusReport).toHaveBeenCalledTimes(2);
    expect(DAC.db.saveNotification).toHaveBeenCalledTimes(1);
  });

  test('notification message highlights only changed fields when some remain the same', async () => {
    jest
      .spyOn(vehiclePositionsService, 'getVehicles')
      .mockReturnValue([sampleVehicle]);
    jest
      .spyOn(moderationService, 'moderate')
      .mockResolvedValue({ flagged: false });

    const savedReport: IBusReport = {
      _id: 'rpt-4',
      userId: 'user-1',
      vid: 'V100',
      routeId: '61C',
      crowdedness: 'Packed',
      condition: 'Clean',
      lat: nearbyCoords.lat,
      lon: nearbyCoords.lon,
      createdAt: new Date().toISOString()
    };

    DAC.db = createMockDb({
      saveBusReport: jest.fn().mockResolvedValue(savedReport),
      saveNotification: jest
        .fn()
        .mockImplementation((n: INotification) =>
          Promise.resolve({ ...n, _id: 'notif-x' })
        )
    });

    // First report: sets crowdedness=Packed, condition=Clean
    await NotificationModel.submitReport('user-1', {
      vid: 'V100',
      routeId: '61C',
      crowdedness: 'Packed',
      condition: 'Clean',
      lat: nearbyCoords.lat,
      lon: nearbyCoords.lon
    });

    // Second report: crowdedness stays Packed, condition changes to Dirty
    const result = await NotificationModel.submitReport('user-1', {
      vid: 'V100',
      routeId: '61C',
      crowdedness: 'Packed',
      condition: 'Dirty',
      lat: nearbyCoords.lat,
      lon: nearbyCoords.lon
    });

    expect(result.notification).not.toBeNull();
    expect(result.notification!.changedFields).toEqual(['condition']);
    expect(result.notification!.message).toContain(
      'Condition changed to Dirty'
    );
    expect(result.notification!.message).not.toContain('Crowdedness');
  });
});

// ============================================================================
// LLM Content Moderation (R11)
// ============================================================================

describe('Content moderation (R11)', () => {
  beforeEach(() => {
    resetLastKnownStatus();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('flagged comment is excluded from notification but report is still stored', async () => {
    jest
      .spyOn(vehiclePositionsService, 'getVehicles')
      .mockReturnValue([sampleVehicle]);
    jest.spyOn(moderationService, 'moderate').mockResolvedValue({
      flagged: true,
      reason: 'Contains profanity',
      category: 'inappropriate'
    });

    const savedReport: IBusReport = {
      _id: 'rpt-5',
      userId: 'user-1',
      vid: 'V100',
      routeId: '61C',
      crowdedness: 'Empty',
      comment: 'bad word here',
      lat: nearbyCoords.lat,
      lon: nearbyCoords.lon,
      createdAt: new Date().toISOString()
    };

    DAC.db = createMockDb({
      saveBusReport: jest.fn().mockResolvedValue(savedReport),
      saveNotification: jest
        .fn()
        .mockImplementation((n: INotification) =>
          Promise.resolve({ ...n, _id: 'notif-5' })
        )
    });

    const result = await NotificationModel.submitReport('user-1', {
      vid: 'V100',
      routeId: '61C',
      crowdedness: 'Empty',
      comment: 'bad word here',
      lat: nearbyCoords.lat,
      lon: nearbyCoords.lon
    });

    expect(result.commentFlagged).toBe(true);
    expect(result.commentFlagCategory).toBe('inappropriate');
    // Report was saved (comment preserved in report storage)
    expect(DAC.db.saveBusReport).toHaveBeenCalled();
    // Notification was still created (from the crowdedness change)
    expect(result.notification).not.toBeNull();
    // But the notification message does NOT contain the flagged comment
    expect(result.notification!.message).not.toContain('bad word here');
  });

  test('unflagged comment is included in the notification message', async () => {
    jest
      .spyOn(vehiclePositionsService, 'getVehicles')
      .mockReturnValue([sampleVehicle]);
    jest
      .spyOn(moderationService, 'moderate')
      .mockResolvedValue({ flagged: false });

    const savedReport: IBusReport = {
      _id: 'rpt-6',
      userId: 'user-1',
      vid: 'V100',
      routeId: '61C',
      crowdedness: 'Standing Room',
      comment: 'Very crowded today',
      lat: nearbyCoords.lat,
      lon: nearbyCoords.lon,
      createdAt: new Date().toISOString()
    };

    DAC.db = createMockDb({
      saveBusReport: jest.fn().mockResolvedValue(savedReport),
      saveNotification: jest
        .fn()
        .mockImplementation((n: INotification) =>
          Promise.resolve({ ...n, _id: 'notif-6' })
        )
    });

    const result = await NotificationModel.submitReport('user-1', {
      vid: 'V100',
      routeId: '61C',
      crowdedness: 'Standing Room',
      comment: 'Very crowded today',
      lat: nearbyCoords.lat,
      lon: nearbyCoords.lon
    });

    expect(result.commentFlagged).toBe(false);
    expect(result.notification).not.toBeNull();
    expect(result.notification!.message).toContain('Very crowded today');
  });
});

// ============================================================================
// Keyword Filter in Moderation Service
// ============================================================================

describe('Moderation service keyword filter', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    // Force keyword-filter fallback by making any Gemini call fail
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('network disabled'));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('profane comment is flagged by keyword filter', async () => {
    const result = await moderationService.moderate('this is shit');

    expect(result.flagged).toBe(true);
    expect(result.category).toBe('inappropriate');
  });

  test('clean comment passes the keyword filter', async () => {
    const result = await moderationService.moderate(
      'Bus is running on time today'
    );

    expect(result.flagged).toBe(false);
  });

  test('empty comment is not flagged', async () => {
    const result = await moderationService.moderate('');

    expect(result.flagged).toBe(false);
  });
});

// ============================================================================
// Notification Search (R3)
// ============================================================================

describe('Notification search', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('search by route returns matching notifications', async () => {
    const notifications: INotification[] = [
      {
        _id: 'n1',
        routeId: '61C',
        vid: 'V100',
        message: 'Bus #V100 on Route 61C — Crowdedness changed to Packed',
        changedFields: ['crowdedness'],
        reportId: 'rpt-1',
        createdAt: new Date().toISOString()
      }
    ];

    DAC.db = createMockDb({
      getRecentNotifications: jest.fn().mockResolvedValue(notifications)
    });

    const result = await NotificationModel.searchNotifications({
      route: '61C'
    });

    expect(result).toHaveLength(1);
    expect(result[0].routeId).toBe('61C');
    expect(DAC.db.getRecentNotifications).toHaveBeenCalledWith({
      routeId: '61C'
    });
  });

  test('free-text search filters notifications by message content', async () => {
    const notifications: INotification[] = [
      {
        _id: 'n1',
        routeId: '61C',
        vid: 'V100',
        message: 'Bus #V100 on Route 61C — Crowdedness changed to Packed',
        changedFields: ['crowdedness'],
        reportId: 'rpt-1',
        createdAt: new Date().toISOString()
      },
      {
        _id: 'n2',
        routeId: '61C',
        vid: 'V200',
        message: 'Bus #V200 on Route 61C — Condition changed to Clean',
        changedFields: ['condition'],
        reportId: 'rpt-2',
        createdAt: new Date().toISOString()
      }
    ];

    DAC.db = createMockDb({
      getRecentNotifications: jest.fn().mockResolvedValue(notifications)
    });

    const result = await NotificationModel.searchNotifications({
      q: 'Packed'
    });

    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('Packed');
  });

  test('search with no matching free-text returns empty array', async () => {
    const notifications: INotification[] = [
      {
        _id: 'n1',
        routeId: '61C',
        vid: 'V100',
        message: 'Bus #V100 on Route 61C — Crowdedness changed to Packed',
        changedFields: ['crowdedness'],
        reportId: 'rpt-1',
        createdAt: new Date().toISOString()
      }
    ];

    DAC.db = createMockDb({
      getRecentNotifications: jest.fn().mockResolvedValue(notifications)
    });

    const result = await NotificationModel.searchNotifications({
      q: 'nonexistent'
    });

    expect(result).toHaveLength(0);
  });
});
