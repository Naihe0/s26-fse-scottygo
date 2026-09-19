/** @jest-environment jsdom */

import {
  appendLinkedText,
  formatAlertMetadata,
  formatNotificationTime,
  notificationTopics,
  routeMapUrl,
  safeHttpUrl
} from '../../client/scripts/utils/alert-content';
import {
  createLiveUpdateCard,
  createServiceAlertCard
} from '../../client/scripts/utils/notification-card';
import type {
  INotification,
  IServiceAlert
} from '../../common/transit.interface';

const routeDisplay = (id: string) => ({
  title: `Route ${id}`,
  subtitle: 'PRT'
});
const alert: IServiceAlert = {
  id: 'one',
  headerText: 'A service change',
  descriptionText: 'Please check your route.',
  routeIds: ['71C'],
  activePeriods: []
};

describe('safe alert links', () => {
  test.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//example.com',
    '/relative',
    'mailto:test@example.com',
    'https://user:password@example.com',
    'https://example.com\\evil',
    'https://example.com/a\nb',
    'https://example.com/\u0000',
    'https://',
    'http://[broken'
  ])('rejects %s', (value) => {
    expect(safeHttpUrl(value)).toBeNull();
  });

  test('permits only explicit valid web protocols and encodes the parsed destination', () => {
    expect(safeHttpUrl(' HTTPS://example.com/a?q=one&b=two ')).toBe(
      'https://example.com/a?q=one&b=two'
    );
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com/');
  });

  test('preserves feed text and trailing punctuation without creating HTML', () => {
    const container = document.createElement('p');
    const text =
      '<img src=x onerror=alert(1)> See https://example.com/route?q=a&b=c. Then (https://example.com/a_(b)).';
    appendLinkedText(container, text);
    expect(container.textContent).toBe(text);
    expect(container.querySelector('img')).toBeNull();
    const links = [...container.querySelectorAll('a')];
    expect(links.map((link) => link.href)).toEqual([
      'https://example.com/route?q=a&b=c',
      'https://example.com/a_(b)'
    ]);
    expect(
      links.every(
        (link) => link.target === '_blank' && link.rel === 'noopener noreferrer'
      )
    ).toBe(true);
  });

  test('ends URLs at markup separators and keeps unsupported URL syntax literal', () => {
    const container = document.createElement('p');
    const text =
      'https://rebrand.ly/v1uafmq>Touchatrunk javascript:alert(1) https://user:pass@example.com https://example.com/path"onclick="evil';
    appendLinkedText(container, text);
    expect(container.textContent).toBe(text);
    expect(
      [...container.querySelectorAll('a')].map((link) => link.href)
    ).toEqual(['https://rebrand.ly/v1uafmq', 'https://example.com/path']);
    expect(container.querySelector('[onclick]')).toBeNull();
  });

  test('encodes route identifiers as a single map parameter', () => {
    expect(routeMapUrl('CMU-123&dir=OB/#x')).toBe(
      '/#/map?r=CMU-123%26dir%3DOB%2F%23x'
    );
  });
});

describe('notification metadata and cards', () => {
  test('topics and labels use only actual recognized metadata', () => {
    expect(
      notificationTopics(['crowdedness', 'crowdedness', 'condition', 'evil'])
    ).toEqual(['Crowding', 'Bus condition']);
    expect(notificationTopics()).toEqual([]);
    expect(formatAlertMetadata('DETOUR')).toBe('Detour');
    expect(formatAlertMetadata('UNKNOWN_EFFECT')).toBeNull();
    expect(formatAlertMetadata('<img>')).toBeNull();
  });

  test('handles current, old, future and invalid timestamps without NaN or negative ages', () => {
    const now = Date.parse('2026-09-19T12:00:00Z');
    expect(formatNotificationTime('2026-09-19T11:59:30Z', now)).toBe(
      'Just now'
    );
    expect(formatNotificationTime('2026-09-19T11:45:00Z', now)).toBe(
      '15 min ago'
    );
    expect(formatNotificationTime('2026-09-19T10:00:00Z', now)).toBe(
      '2 hr ago'
    );
    expect(formatNotificationTime('2026-09-17T10:00:00Z', now)).not.toContain(
      'hr ago'
    );
    expect(formatNotificationTime('2026-09-20T10:00:00Z', now)).not.toContain(
      'ago'
    );
    expect(formatNotificationTime('not a time', now)).toBe('Time unavailable');
  });

  test('an agency card exposes metadata, source links, and encoded route actions', () => {
    const card = createServiceAlertCard(
      {
        ...alert,
        headerText: 'Notice https://example.com/title',
        effect: 'DETOUR',
        cause: 'CONSTRUCTION',
        severityLevel: 'WARNING',
        url: 'https://example.com/full',
        routeIds: ['71C', '71C', 'CMU-12']
      },
      routeDisplay
    );
    expect(card.querySelector('.notif-severity')?.textContent).toBe('Warning');
    expect(card.querySelector('.notif-topics')?.textContent).toBe(
      'Detour · Construction'
    );
    expect(card.querySelectorAll('.notif-route')).toHaveLength(2);
    expect(card.querySelector('.notif-route')?.getAttribute('href')).toBe(
      '/#/map?r=71C'
    );
    expect(card.querySelector('.notif-title a')?.getAttribute('href')).toBe(
      'https://example.com/title'
    );
    expect(card.querySelector('.notif-source')?.getAttribute('rel')).toBe(
      'noopener noreferrer'
    );
  });

  test('unknown severity and unsafe source links are not rendered', () => {
    const card = createServiceAlertCard(
      { ...alert, url: 'javascript:alert(1)' },
      routeDisplay
    );
    expect(card.querySelector('.notif-severity')).toBeNull();
    expect(card.querySelector('.notif-source')).toBeNull();
  });

  test('long descriptions and extra routes have native disclosures without losing content', () => {
    const description =
      'A detailed notice. '.repeat(30) + 'https://example.com/details';
    const card = createServiceAlertCard(
      {
        ...alert,
        descriptionText: description,
        routeIds: Array.from({ length: 9 }, (_, index) => String(index))
      },
      routeDisplay
    );
    expect(card.querySelector<HTMLDetailsElement>('.notif-details')?.open).toBe(
      false
    );
    expect(card.querySelector('.notif-body')?.textContent).toBe(description);
    expect(card.querySelector('.notif-details a')?.getAttribute('href')).toBe(
      'https://example.com/details'
    );
    expect(
      card.querySelector('.notif-route-details summary')?.textContent
    ).toBe('3 more routes');
    expect(card.querySelectorAll('.notif-route')).toHaveLength(9);
  });

  test('communication windows explain open ends and skip malformed dates', () => {
    const card = createServiceAlertCard(
      {
        ...alert,
        activePeriods: [
          { start: '2026-09-19T12:00:00Z', end: '' },
          { start: '', end: '2026-09-20T12:00:00Z' },
          { start: 'bad', end: 'bad' }
        ]
      },
      routeDisplay
    );
    expect(card.querySelector('.notif-window summary')?.textContent).toBe(
      'Alert window'
    );
    expect(card.textContent).toContain('end not provided');
    expect(card.textContent).toContain('Until');
    expect(card.textContent).toContain('service disruption times may differ');
    expect(card.textContent).not.toContain('Invalid Date');
  });

  test('rider reports retain literal text and label the bus, topics and absolute timestamp', () => {
    const notification: INotification = {
      routeId: '71C',
      vid: '<script>',
      message: '<img src=x> https://example.com/report',
      changedFields: ['prioritySeating'],
      reportId: 'report',
      createdAt: '2026-09-19T12:00:00Z'
    };
    const card = createLiveUpdateCard(
      notification,
      routeDisplay,
      (text) => text
    );
    expect(card.querySelector('script, img')).toBeNull();
    expect(card.querySelector('.notif-body')?.textContent).toBe(
      notification.message
    );
    expect(card.querySelector('.notif-topics')?.textContent).toBe(
      'Priority seating'
    );
    expect(card.querySelector('time')?.dateTime).toBe(
      notification.createdAt.replace('Z', '.000Z')
    );
    expect(card.querySelector('time')?.title).toBeTruthy();
  });
});
