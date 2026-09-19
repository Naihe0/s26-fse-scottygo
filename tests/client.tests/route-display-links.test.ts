import {
  buildRouteDisplayMap,
  formatNotificationMessage
} from '../../client/scripts/utils/route-display';

const routes = buildRouteDisplayMap([
  { id: 'CMU-123', name: 'Green Route', system: 'CMU' }
]);

test('friendly shuttle names never rewrite a destination inside a clickable URL', () => {
  const message =
    'CMU-123: See https://agency.example/routes/CMU-123?route=CMU-123#CMU-123. Then take cmu-123.';
  expect(formatNotificationMessage(message, routes)).toBe(
    'Green Route: See https://agency.example/routes/CMU-123?route=CMU-123#CMU-123. Then take Green Route.'
  );
});

test('unknown shuttle IDs remain readable without metadata', () => {
  expect(formatNotificationMessage('Take CMU-999', routes)).toBe(
    'Take CMU-999'
  );
});
