const zone = 'America/New_York';
const year = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  timeZone: zone
});
const shortDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: zone
});
const fullDate = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: zone
});
const exactTime = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: zone,
  timeZoneName: 'short'
});

/** Short recent ages and calendar dates for older events; exact times use the transit system's zone. */
export function describeRiderTime(
  timestamp: string,
  now = Date.now()
): {
  label: string;
  absolute: string;
  iso: string;
} | null {
  const date = new Date(timestamp);
  if (
    !Number.isFinite(date.getTime()) ||
    !Number.isFinite(new Date(now).getTime())
  )
    return null;
  const elapsed = now - date.getTime();
  let label: string;
  if (elapsed >= -60_000 && elapsed < 60_000) label = 'just now';
  else if (elapsed >= 60_000 && elapsed < 3_600_000)
    label = `${Math.floor(elapsed / 60_000)} min ago`;
  else if (elapsed >= 3_600_000 && elapsed < 86_400_000)
    label = `${Math.floor(elapsed / 3_600_000)} hr ago`;
  else if (elapsed >= 86_400_000 && elapsed < 7 * 86_400_000)
    label = `${Math.floor(elapsed / 86_400_000)} days ago`;
  else
    label = (
      year.format(date) === year.format(now) ? shortDate : fullDate
    ).format(date);
  if (label === '1 days ago') label = '1 day ago';
  return { label, absolute: exactTime.format(date), iso: date.toISOString() };
}
