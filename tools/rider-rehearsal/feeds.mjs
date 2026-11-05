const route = {
  id: '61C',
  name: 'McKeesport',
  system: 'PRT',
  directions: ['INBOUND', 'OUTBOUND'],
  color: '#217650',
  activeStatus: true,
  operatingDays: [0, 1, 2, 3, 4, 5, 6]
};
const shuttle = {
  ...route,
  id: 'CMU-1',
  name: 'Campus Shuttle',
  system: 'CMU'
};
const stop = {
  stopId: '7117',
  stopName: 'Forbes at Campus',
  lat: 40.443,
  lon: -79.944,
  routes: ['61C', 'CMU-1'],
  dtradd: [],
  dtrrem: []
};
const farther = {
  ...stop,
  stopId: '7118',
  stopName: 'Fifth Avenue',
  lat: 40.446
};
const path = [stop, farther].map((s) => ({ lat: s.lat, lng: s.lon }));
const pattern = { direction: 'INBOUND', shapeId: '61C-in', path };
const user = {
  credentials: { username: 'rider' },
  _id: 'demo-rider',
  email: 'rider@andrew.cmu.edu',
  privilegeLevel: 'Member',
  status: 'Active',
  agreed: true,
  onboardingComplete: true
};
const token =
  'fixture.' +
  Buffer.from(JSON.stringify({ userId: user._id })).toString('base64url') +
  '.fixture';
export function apiFixture() {
  const subscriptions = new Set(['61C']);
  const events = { reports: [], checks: 0 };
  const response = (name, payload, status = 200) => ({
    status,
    json: { name, payload }
  });
  function handle(url, request) {
    const p = url.pathname;
    if (p.startsWith('/auth/tokens/'))
      return response('UserAuthenticated', { token, user });
    if (p.startsWith('/users/')) return response('UserFound', user);
    if (p === '/auth/validate' || p.includes('/validate/'))
      return response('ValidationPassed', true);
    if (p === '/account/users') return response('UsersRetrieved', ['rider']);
    if (p.startsWith('/account/users/'))
      return response('AccountRetrieved', user);
    if (p === '/config')
      return response('ConfigFound', {
        lat: 40.443,
        lon: -79.944,
        defaultZoom: 16,
        apiKey: 'local-fixture'
      });
    if (p === '/transit/health') {
      const feed = { healthy: true, consecutiveFailures: 0, error: null };
      return {
        json: {
          overall: true,
          gtfs: { ready: true },
          vehiclePositions: feed,
          tripUpdates: feed,
          tripshotLiveStatus: feed,
          trueTimeColors: { available: true },
          memory: {}
        }
      };
    }
    if (p === '/transit/routes' || p === '/transit/routes/available')
      return response('RoutesRetrieved', [route, shuttle]);
    if (p === '/transit/bulk')
      return response('BulkDataRetrieved', {
        routes: [route, shuttle],
        patterns: { '61C': [pattern], 'CMU-1': [pattern] },
        stops: { '61C:INBOUND': [stop, farther], 'CMU-1:INBOUND': [stop] }
      });
    if (p === '/search')
      return response('SearchTransitCompleted', {
        routes: [route],
        stops: [stop, farther]
      });
    if (p.startsWith('/transit/vehicles/'))
      return response(
        'VehiclesLocated',
        p.endsWith('61C')
          ? [
              {
                vid: '4100',
                routeId: '61C',
                lat: 40.4431,
                lon: -79.944,
                source: 'live',
                lastUpdate: new Date().toISOString(),
                isDetoured: false,
                heading: 0,
                speed: 2,
                direction: 'INBOUND',
                currentStopId: stop.stopId,
                currentStatus: 'IN_TRANSIT_TO'
              }
            ]
          : []
      );
    if (p.endsWith('/predictions')) {
      events.checks++;
      return response(
        'PredictionsRetrieved',
        [3, 8, 15].map((minutes) => ({
          minutes,
          stopId: stop.stopId,
          routeId: '61C',
          vid: '4100',
          predictedArrivalTime: Date.now() + minutes * 60000,
          isDelayed: false
        }))
      );
    }
    if (p.endsWith('/nearbystops'))
      return response('NearbyStopsRetrieved', {
        center: { lat: 40.443, lon: -79.944 },
        radiusMeters: 600,
        expandedRadiusApplied: false,
        stops: [stop, farther].map((s, i) => ({
          stop: s,
          distanceMeters: 180 * i + 30,
          walkMinutesEstimate: 2 * i + 1,
          routesServingStop: s.routes
        }))
      });
    if (p.startsWith('/transit/stops/'))
      return response('StopsRetrieved', [stop, farther]);
    if (p.endsWith('/schedule'))
      return response('RouteScheduleRetrieved', {
        routeId: route.id,
        routeName: route.name,
        system: route.system,
        operatingDays: route.operatingDays,
        directions: [
          { direction: 'INBOUND', firstTrip: '05:15', lastTrip: '23:45' }
        ],
        alerts: [],
        detours: []
      });
    if (p.startsWith('/transit/routes/'))
      return response('PathGenerated', [pattern]);
    if (p.startsWith('/transit/detours/'))
      return response('DetoursRetrieved', []);
    if (p.startsWith('/notifications/subscriptions')) {
      if (request.method() === 'POST') {
        const { routeId } = request.postDataJSON();
        subscriptions.add(routeId);
        return response(
          'SubscriptionCreated',
          { routeId, createdAt: new Date().toISOString() },
          201
        );
      }
      if (request.method() === 'DELETE')
        subscriptions.delete(decodeURIComponent(p.split('/').at(-1)));
      return response(
        'SubscriptionsRetrieved',
        [...subscriptions].map((routeId) => ({
          routeId,
          createdAt: new Date().toISOString()
        })),
        request.method() === 'POST' ? 201 : 200
      );
    }
    if (p === '/notifications/alerts')
      return response('AlertsRetrieved', [
        {
          id: '61C-test',
          headerText: 'Forbes stop relocated',
          descriptionText: 'Use Fifth Avenue.',
          routeIds: ['61C'],
          activePeriods: [],
          severityLevel: 'WARNING'
        }
      ]);
    if (p === '/notifications/notifications')
      return response('NotificationsRetrieved', []);
    if (p === '/notifications/reports' && request.method() === 'POST') {
      events.reports.push(request.postDataJSON());
      return response('ReportCreated', {}, 201);
    }
    return null;
  }
  return { events, handle };
}
