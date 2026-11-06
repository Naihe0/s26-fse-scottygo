import { agencyWindowState } from '../../client/scripts/utils/agency-window';

test('publication windows use half-open boundaries and can reopen after a gap', () => {
  const windows = [
    { start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z' },
    { start: '2026-11-05T14:00:00Z', end: '2026-11-05T16:00:00Z' }
  ];
  const when = (hour: string) => Date.parse('2026-11-05T' + hour + ':00:00Z');
  expect(agencyWindowState(windows, when('10'))).toBe('current');
  expect(agencyWindowState(windows, when('11'))).toBe('upcoming');
  expect(agencyWindowState(windows, when('16'))).toBe('ended');
  expect(agencyWindowState([{ start: '', end: 'bad' }], when('10'))).toBe(
    'unknown'
  );
  expect(agencyWindowState([{ start: '', end: '' }], when('10'))).toBe(
    'unknown'
  );
  expect(
    agencyWindowState([{ start: '', end: windows[0].end }], when('08'))
  ).toBe('current');
  expect(
    agencyWindowState([{ start: windows[0].start, end: '' }], when('23'))
  ).toBe('current');
});
