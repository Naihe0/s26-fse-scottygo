import type { IServiceAlert } from '../../../common/transit.interface';

export type WindowState = 'current' | 'upcoming' | 'ended' | 'unknown';

export function agencyWindowState(
  periods: IServiceAlert['activePeriods'] = [],
  now = Date.now()
): WindowState {
  let future = false;
  let ended = false;
  for (const { start, end } of periods) {
    if (!start && !end) continue;
    const from = start ? Date.parse(start) : -Infinity;
    const until = end ? Date.parse(end) : Infinity;
    if (Number.isNaN(from) || Number.isNaN(until) || from >= until) continue;
    if (now >= from && now < until) return 'current';
    if (from > now) future = true;
    else ended = true;
  }
  return future ? 'upcoming' : ended ? 'ended' : 'unknown';
}

export const agencyWindowLabels: Record<WindowState, string> = {
  current: 'Notice window open',
  upcoming: 'Upcoming notice window',
  ended: 'Notice window ended',
  unknown: 'Window not supplied'
};
