/** Feed and rider text stays text; only explicit, validated web URLs become links. */
export function safeHttpUrl(value: string): string | null {
  const candidate = value.trim();
  if (
    !/^https?:\/\//i.test(candidate) ||
    /[\s\\]/.test(candidate) ||
    [...candidate].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    )
  ) {
    return null;
  }
  try {
    const url = new URL(candidate);
    if (!url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function trimUrlPunctuation(value: string): string {
  let trimmed = value.replace(/[.,;:!?]+$/, '');
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}']
  ]) {
    while (
      trimmed.endsWith(close) &&
      trimmed.split(close).length > trimmed.split(open).length
    ) {
      trimmed = trimmed.slice(0, -1);
    }
  }
  return trimmed;
}

export function appendLinkedText(container: HTMLElement, text: string): void {
  const pattern = /\bhttps?:\/\/[^\s<>"']+/gi;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    const label = trimUrlPunctuation(match[0]);
    const href = safeHttpUrl(label);
    if (!href) continue;
    container.append(document.createTextNode(text.slice(offset, start)));
    const link = document.createElement('a');
    link.href = href;
    link.textContent = label;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'alert-link';
    link.dataset.action = `url:${href}`;
    link.title = 'Open website in a new tab';
    container.append(link);
    offset = start + label.length;
  }
  container.append(document.createTextNode(text.slice(offset)));
}

export function routeMapUrl(routeId: string): string {
  return `/#/map?${new URLSearchParams({ r: routeId })}`;
}

export function formatNotificationTime(
  timestamp: string,
  now = Date.now()
): string {
  const date = new Date(timestamp);
  const time = date.getTime();
  if (!Number.isFinite(time)) return 'Time unavailable';
  const elapsed = now - time;
  if (elapsed < -60_000 || elapsed >= 86_400_000) {
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }
  const minutes = Math.floor(Math.max(0, elapsed) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} hr ago`;
}

export function notificationTopics(changedFields: string[] = []): string[] {
  const labels: Record<string, string> = {
    crowdedness: 'Crowding',
    prioritySeating: 'Priority seating',
    condition: 'Bus condition',
    comment: 'Rider comment'
  };
  return [
    ...new Set(
      changedFields.flatMap((field) => (labels[field] ? [labels[field]] : []))
    )
  ];
}

export function formatAlertMetadata(value?: string): string | null {
  if (!value || /^(UNKNOWN_|OTHER_)/.test(value)) return null;
  const labels: Record<string, string> = {
    NO_SERVICE: 'No service',
    REDUCED_SERVICE: 'Reduced service',
    SIGNIFICANT_DELAYS: 'Significant delays',
    DETOUR: 'Detour',
    ADDITIONAL_SERVICE: 'Additional service',
    MODIFIED_SERVICE: 'Modified service',
    STOP_MOVED: 'Stop moved',
    NO_EFFECT: 'No service change',
    ACCESSIBILITY_ISSUE: 'Accessibility issue',
    TECHNICAL_PROBLEM: 'Technical problem',
    STRIKE: 'Strike',
    DEMONSTRATION: 'Demonstration',
    ACCIDENT: 'Accident',
    HOLIDAY: 'Holiday',
    WEATHER: 'Weather',
    MAINTENANCE: 'Maintenance',
    CONSTRUCTION: 'Construction',
    POLICE_ACTIVITY: 'Police activity',
    MEDICAL_EMERGENCY: 'Medical emergency',
    INFO: 'Information',
    WARNING: 'Warning',
    SEVERE: 'Severe'
  };
  return labels[value] ?? null;
}
