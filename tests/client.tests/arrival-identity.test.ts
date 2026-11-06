import { keyArrivalRows } from '../../client/scripts/utils/arrival-identity';
import type { IPrediction } from '../../common/transit.interface';

const row = (time: number, occurrenceId?: string): IPrediction => ({
  routeId: '61C',
  stopId: '42',
  vid: '3001',
  predictedArrivalTime: time,
  minutes: 3,
  isDelayed: false,
  occurrenceId
});
test('different visits on one bus survive independent ETA changes and reordering', () => {
  const a = row(100, 'trip-A'),
    b = row(200, 'trip-B'),
    moved = row(175, 'trip-B');
  const keys = keyArrivalRows([a, b]);
  expect(keys.get(a)).not.toBe(keys.get(b));
  expect(keyArrivalRows([moved, a]).get(moved)).toBe(keys.get(b));
});
test('legacy duplicate vehicles remain distinct and ambiguous time changes do not silently transfer a selection', () => {
  const a = row(100),
    b = row(200),
    later = row(220);
  const keys = keyArrivalRows([a, b]);
  expect(keys.get(a)).not.toBe(keys.get(b));
  expect(keyArrivalRows([a, later]).get(later)).not.toBe(keys.get(b));
  expect(keyArrivalRows([a]).get(a)).toBe(keyArrivalRows([later]).get(later));
});
