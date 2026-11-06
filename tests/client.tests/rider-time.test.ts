import { describeRiderTime } from '../../client/scripts/utils/rider-time';

const now = Date.parse('2026-11-06T12:00:00Z');
test.each([
  ['2026-11-06T11:59:45Z', 'just now'],
  ['2026-11-06T11:58:59Z', '1 min ago'],
  ['2026-11-06T11:00:01Z', '59 min ago'],
  ['2026-11-06T10:00:00Z', '2 hr ago'],
  ['2026-11-05T12:00:00Z', '1 day ago'],
  ['2026-11-02T12:00:00Z', '4 days ago'],
  ['2026-09-19T18:00:00Z', 'Sep 19'],
  ['2025-09-19T18:00:00Z', 'Sep 19, 2025'],
  ['2026-11-06T14:00:00Z', 'Nov 6']
])('describes %s as %s without unbounded hours', (timestamp, expected) => {
  expect(describeRiderTime(timestamp, now)?.label).toBe(expected);
});

test('exact dates explicitly use Pittsburgh daylight and standard time', () => {
  expect(describeRiderTime('2026-09-19T18:00:00Z', now)?.absolute).toMatch(
    /Sep 19, 2026.*2:00 PM EDT/
  );
  expect(describeRiderTime('2026-11-06T12:00:00Z', now)?.absolute).toMatch(
    /Nov 6, 2026.*7:00 AM EST/
  );
  expect(describeRiderTime('2026-09-19T18:00:00Z', now)?.iso).toBe(
    '2026-09-19T18:00:00.000Z'
  );
});

test('compares calendar years in Pittsburgh at the New Year boundary', () => {
  const midnightUTC = Date.parse('2027-01-01T01:00:00Z');
  expect(describeRiderTime('2026-09-19T18:00:00Z', midnightUTC)?.label).toBe(
    'Sep 19'
  );
  expect(
    describeRiderTime('2026-09-19T18:00:00Z', midnightUTC + 6 * 3600000)?.label
  ).toBe('Sep 19, 2026');
});

test('invalid dates do not become NaN hours or trigger an Intl error', () => {
  expect(describeRiderTime('', now)).toBeNull();
  expect(describeRiderTime('invalid', now)).toBeNull();
  expect(describeRiderTime('2026-11-06T12:00:00Z', NaN)).toBeNull();
});
