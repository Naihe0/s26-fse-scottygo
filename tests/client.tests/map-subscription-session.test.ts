/** @jest-environment jsdom */

import axios from 'axios';
const mockAddSubscription = jest.fn();
const mockRemoveSubscription = jest.fn();
const mockToast = jest.fn();
jest.mock('axios');
jest.mock('../../client/scripts/services/auth.service', () => ({
  authService: {
    addSubscription: (...args: unknown[]) => mockAddSubscription(...args),
    removeSubscription: (...args: unknown[]) => mockRemoveSubscription(...args)
  }
}));
jest.mock('../../client/scripts/utils/toast', () => ({
  showToast: (...args: unknown[]) => mockToast(...args)
}));
jest.mock('../../client/scripts/components/live-notifications', () => ({}));
jest.mock('../../client/scripts/maps/google-map.provider', () => ({
  GoogleMapProvider: jest.fn()
}));
jest.mock('../../client/scripts/state/map-state', () => ({
  MapStateManager: {
    getInstance: () => ({ getState: () => ({ availableRoutes: [] }) })
  }
}));
jest.mock('../../client/scripts/state/url-sync', () => ({
  URLSyncManager: { getInstance: () => ({}) }
}));
jest.mock('../../client/scripts/controllers/filter-controller', () => ({
  FilterController: { getInstance: () => ({}) }
}));
jest.mock('../../client/scripts/controllers/directions-controller', () => ({
  DirectionsController: { getInstance: () => ({}) }
}));
jest.mock('../../client/scripts/renderers/route-renderer', () => ({
  RouteRenderer: { getInstance: () => ({}) }
}));
jest.mock('../../client/scripts/trackers/vehicle-tracker', () => ({
  VehicleTracker: { getInstance: () => ({}) }
}));

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('map bell requests belong to the session that sent them', () => {
  const onJoin = jest.fn();
  const onLeave = jest.fn();
  let bellUpdate: jest.SpyInstance;

  beforeAll(async () => {
    const addListener = document.addEventListener.bind(document);
    const ready = jest
      .spyOn(document, 'addEventListener')
      .mockImplementation((type, listener, options) => {
        if (type !== 'DOMContentLoaded') addListener(type, listener, options);
      });
    const { registerSubscriptionEvents } =
      await import('../../client/scripts/map');
    ready.mockRestore();
    registerSubscriptionEvents();
    document.addEventListener('notifRouteJoin', onJoin);
    document.addEventListener('notifRouteLeave', onLeave);
  });
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.setItem('token', 'first-user');
    document.body.innerHTML = '<route-bell></route-bell>';
    const bell = document.querySelector('route-bell') as HTMLElement & {
      showBell(route: string, subscribed: boolean): void;
    };
    bellUpdate = jest.spyOn(bell, 'showBell');
  });
  afterEach(() => {
    bellUpdate.mockRestore();
  });

  test.each([
    ['bellSubscribe', false],
    ['bellUnsubscribe', false],
    ['bellSubscribe', true],
    ['bellUnsubscribe', true]
  ] as const)(
    '%s ignores an old-session completion (rejected=%s)',
    async (eventName, rejected) => {
      let finish!: (value: unknown) => void;
      let fail!: (reason: unknown) => void;
      const pending = new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      if (eventName === 'bellSubscribe')
        jest.mocked(axios.post).mockReturnValueOnce(pending);
      else jest.mocked(axios.delete).mockReturnValueOnce(pending);
      document.dispatchEvent(
        new CustomEvent(eventName, { detail: { routeId: '61D' } })
      );
      localStorage.setItem('token', 'second-user');
      if (rejected) fail(new Error('offline'));
      else
        finish({
          status: eventName === 'bellSubscribe' ? 201 : 200,
          data: { name: 'RouteSubscribed' }
        });
      await flush();
      expect(mockAddSubscription).not.toHaveBeenCalled();
      expect(mockRemoveSubscription).not.toHaveBeenCalled();
      expect(onJoin).not.toHaveBeenCalled();
      expect(onLeave).not.toHaveBeenCalled();
      expect(mockToast).not.toHaveBeenCalled();
      expect(bellUpdate).not.toHaveBeenCalled();
    }
  );

  test('a successful response for the current session still updates cache and socket membership', async () => {
    jest.mocked(axios.post).mockResolvedValueOnce({
      status: 201,
      data: { name: 'RouteSubscribed' }
    });
    document.dispatchEvent(
      new CustomEvent('bellSubscribe', { detail: { routeId: '61D' } })
    );
    await flush();
    expect(mockAddSubscription).toHaveBeenCalledWith('61D');
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalled();
  });
});
