import { transit_realtime } from 'gtfs-realtime-bindings';
import alertsService from '../../../server/services/alerts.service';
import type { IServiceAlert } from '../../../common/transit.interface';

const decoder = alertsService as unknown as {
  decodeAlertEntity(entity: transit_realtime.IFeedEntity): IServiceAlert | null;
};

function decode(alert: transit_realtime.IAlert): IServiceAlert {
  const encoded = transit_realtime.FeedEntity.encode({
    id: 'agency-alert',
    alert
  }).finish();
  return decoder.decodeAlertEntity(
    transit_realtime.FeedEntity.decode(encoded)
  )!;
}

test('preserves explicit agency metadata with English translations and deduplicated routes', () => {
  const alert = decode({
    headerText: {
      translation: [
        { text: 'Desvío', language: 'es' },
        { text: ' Detour ', language: 'en-US' }
      ]
    },
    descriptionText: { translation: [{ text: 'Details' }] },
    url: { translation: [{ text: 'https://www.rideprt.org/alerts?q=61C' }] },
    effect: transit_realtime.Alert.Effect.DETOUR,
    cause: transit_realtime.Alert.Cause.CONSTRUCTION,
    severityLevel: transit_realtime.Alert.SeverityLevel.WARNING,
    informedEntity: [{ routeId: '61C' }, { routeId: '61C' }, { routeId: '61D' }]
  });
  expect(alert).toMatchObject({
    headerText: 'Detour',
    descriptionText: 'Details',
    effect: 'DETOUR',
    cause: 'CONSTRUCTION',
    severityLevel: 'WARNING',
    routeIds: ['61C', '61D'],
    url: 'https://www.rideprt.org/alerts?q=61C'
  });
});

test('does not mistake inherited protobuf defaults for agency metadata', () => {
  const alert = decode({});
  expect(alert).toEqual({
    id: 'agency-alert',
    headerText: '',
    descriptionText: '',
    routeIds: [],
    activePeriods: []
  });
});

test('unknown and generic enums do not imply a particular effect or urgency', () => {
  const alert = decode({
    effect: 999,
    cause: transit_realtime.Alert.Cause.OTHER_CAUSE,
    severityLevel: transit_realtime.Alert.SeverityLevel.UNKNOWN_SEVERITY
  });
  expect(alert.effect).toBeUndefined();
  expect(alert.cause).toBeUndefined();
  expect(alert.severityLevel).toBeUndefined();
});

test.each([
  'javascript:alert(1)',
  'data:text/html,hello',
  '//example.com',
  'https://user:password@example.com',
  'https://example.com/<script>',
  'https://example.com/a b',
  'http://'
])('rejects unsafe/malformed source URL %s', (url) => {
  expect(decode({ url: { translation: [{ text: url }] } }).url).toBeUndefined();
});

test('translation fallback prefers untagged content over another language and ignores blanks', () => {
  expect(
    decode({
      headerText: {
        translation: [
          { text: '', language: 'en' },
          { text: 'Other', language: 'fr' },
          { text: 'Fallback' }
        ]
      }
    }).headerText
  ).toBe('Fallback');
  expect(
    decode({
      headerText: { translation: [{ text: 'Bonjour', language: 'fr' }] }
    }).headerText
  ).toBe('Bonjour');
});

test('open-ended periods remain open and explicit epoch zero is preserved', () => {
  expect(
    decode({
      activePeriod: [
        { start: 0, end: 3600 },
        { start: 3600 },
        { end: 7200 },
        {}
      ]
    }).activePeriods
  ).toEqual([
    { start: '1970-01-01T00:00:00.000Z', end: '1970-01-01T01:00:00.000Z' },
    { start: '1970-01-01T01:00:00.000Z', end: '' },
    { start: '', end: '1970-01-01T02:00:00.000Z' },
    { start: '', end: '' }
  ]);
});

test('malformed and reversed periods cannot abort valid alert decoding', () => {
  const alert = decoder.decodeAlertEntity({
    id: 'bad-period',
    alert: {
      headerText: { translation: [{ text: 'Still useful' }] },
      activePeriod: [
        { start: Number.NaN },
        { end: -1 },
        { end: 9e15 },
        { start: 20, end: 10 },
        { start: 2, end: 2 },
        { start: 1, end: 2 }
      ]
    }
  })!;
  expect(alert.headerText).toBe('Still useful');
  expect(alert.activePeriods).toEqual([
    { start: '1970-01-01T00:00:01.000Z', end: '1970-01-01T00:00:02.000Z' }
  ]);
});

test('non-alert feed entities are skipped', () => {
  expect(decoder.decodeAlertEntity({ id: 'vehicle', vehicle: {} })).toBeNull();
});
