/** @jest-environment jsdom */
import type { IPrediction } from '../../common/transit.interface';
import {
  buildDepartureSummary,
  shareDepartureSummary
} from '../../client/scripts/utils/share-departure';

const arrival: IPrediction = {
  stopId: '7117',
  routeId: '61C',
  vid: '4100',
  predictedArrivalTime: Date.parse('2026-11-06T05:05:00Z'),
  isDelayed: false,
  minutes: 7
};
const stop = { stopId: '7117', stopName: 'Forbes at Morewood' };
const fresh = {
  available: true,
  missing: false,
  checkedAt: Date.parse('2026-11-06T04:58:00Z')
};
let button: HTMLButtonElement;
let writeText: jest.Mock;
const announce = jest.fn();

beforeEach(() => {
  document.body.innerHTML = '<button>Share departure</button>';
  button = document.querySelector('button')!;
  history.replaceState(
    null,
    '',
    '/private?token=secret&lat=40.123#/map?origin=home'
  );
  writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText }
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    }
  });
  announce.mockClear();
});
afterEach(() => {
  Reflect.deleteProperty(navigator, 'share');
  document.body.innerHTML = '';
});

test('sharing midnight arrivals uses Pittsburgh dates and a public platform URL without rider state', () => {
  const summary = buildDepartureSummary(
    arrival,
    stop,
    fresh,
    'https://user:password@example.com/private?token=secret&lat=40.123#/map?origin=home'
  )!;
  expect(summary.url).toBe('https://example.com/#/map?stop=7117');
  expect(summary.text).toContain('Route 61C · Bus 4100');
  expect(summary.text).toContain('Forbes at Morewood · Stop 7117');
  expect(summary.text).toMatch(/Live estimate: Nov 6, 2026, 12:05 AM EST/);
  expect(summary.text).toMatch(/Checked: Nov 5, 2026, 11:58 PM EST/);
  expect(JSON.stringify(summary)).not.toMatch(
    /password|secret|40\.123|origin=|token=/
  );
});

test('summer clock follows Pittsburgh daylight time and scheduled service does not invent a bus ID', () => {
  const summary = buildDepartureSummary(
    {
      ...arrival,
      vid: 'Scheduled',
      predictedArrivalTime: Date.parse('2026-07-01T16:00:00Z')
    },
    stop,
    fresh
  )!;
  expect(summary.text).toContain('Jul 1, 2026, 12:00 PM EDT');
  expect(summary.text).not.toContain('Bus Scheduled');
});

test('last-known and missing departures retain qualified absolute times without claiming a departure occurred', () => {
  expect(
    buildDepartureSummary(arrival, stop, { ...fresh, available: false })!.text
  ).toContain('Last known estimate:');
  const missing = buildDepartureSummary(arrival, stop, {
    ...fresh,
    available: true,
    missing: true
  })!.text;
  expect(missing).toContain(
    'No longer in current arrivals. Last shown estimate:'
  );
  expect(missing).not.toContain('Live estimate:');
  expect(missing).not.toContain('departed');
});

test('missing clocks stay explicitly unknown and invalid or mismatched public stops cannot be shared', () => {
  const summary = buildDepartureSummary(
    { ...arrival, predictedArrivalTime: NaN },
    stop,
    { ...fresh, checkedAt: null }
  )!;
  expect(summary.text).toContain('time unavailable');
  expect(summary.text).toContain('Checked: not recorded');
  expect(
    buildDepartureSummary(arrival, { ...stop, stopId: '9999' }, fresh)
  ).toBeNull();
  expect(
    buildDepartureSummary(
      { ...arrival, stopId: '../secret' },
      { ...stop, stopId: '../secret' },
      fresh
    )
  ).toBeNull();
  expect(
    buildDepartureSummary(arrival, stop, fresh, 'javascript:alert(1)')
  ).toBeNull();
});

test('native share starts synchronously with the full estimate and cancellation never copies', async () => {
  const share = jest
    .fn()
    .mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: share
  });
  const pending = shareDepartureSummary(arrival, stop, fresh, button, announce);
  expect(share).toHaveBeenCalledWith({
    title: 'ScottyGo departure',
    url: 'http://localhost/#/map?stop=7117',
    text: expect.stringContaining('Live estimate: Nov 6')
  });
  expect(button.disabled).toBe(true);
  await pending;
  expect(writeText).not.toHaveBeenCalled();
  expect(document.querySelector('dialog')).toBeNull();
  expect(button.disabled).toBe(false);
});

test('unavailable native sharing copies the complete qualified text and stop link, not just a URL', async () => {
  const share = jest.fn().mockRejectedValue(new Error('Unavailable'));
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: share
  });
  await shareDepartureSummary(
    arrival,
    stop,
    { ...fresh, available: false },
    button,
    announce
  );
  expect(writeText).toHaveBeenCalledWith(
    expect.stringContaining('Last known estimate:')
  );
  expect(writeText.mock.calls[0][0]).toMatch(
    /\nhttp:\/\/localhost\/#\/map\?stop=7117$/
  );
  expect(announce).toHaveBeenCalledWith(
    'Departure details and stop link copied.'
  );
});

test.each(['missing', 'denied'])(
  'clipboard %s exposes selected multiline details safely and Escape restores focus',
  async (failure) => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value:
        failure === 'missing'
          ? undefined
          : { writeText: jest.fn().mockRejectedValue(new Error('Denied')) }
    });
    await shareDepartureSummary(
      arrival,
      { ...stop, stopName: '<img src=x onerror=alert(1)>' },
      fresh,
      button,
      announce
    );
    const dialog = document.querySelector('dialog')!;
    const field = dialog.querySelector('textarea')!;
    expect(dialog.querySelector('h2')!.textContent).toBe(
      'Copy departure details'
    );
    expect(dialog.querySelector('label')!.getAttribute('for')).toBe(field.id);
    expect(dialog.querySelector('label')!.textContent).toBe(
      'Departure summary'
    );
    expect(announce).toHaveBeenCalledWith('Copy the details in the dialog.');
    expect(dialog.querySelector('img')).toBeNull();
    expect(field.value).toContain('<img src=x onerror=alert(1)>');
    expect(field.value).toContain('http://localhost/#/map?stop=7117');
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);
    expect(document.activeElement).toBe(field);
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  }
);

test('leaving during clipboard permission does not show a manual dialog in the next page', async () => {
  let reject!: (reason: Error) => void;
  writeText.mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail;
    })
  );
  const pending = shareDepartureSummary(arrival, stop, fresh, button, announce);
  button.remove();
  reject(new Error('Denied'));
  await pending;
  expect(document.querySelector('dialog')).toBeNull();
  expect(announce).not.toHaveBeenCalled();
});

test('invalid targets and repeated taps never start a second sharing action', async () => {
  await shareDepartureSummary(
    arrival,
    { ...stop, stopId: 'wrong' },
    fresh,
    button,
    announce
  );
  expect(writeText).not.toHaveBeenCalled();
  expect(announce).toHaveBeenCalledWith('This departure cannot be shared yet.');
  let finish!: () => void;
  writeText.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    })
  );
  const pending = shareDepartureSummary(arrival, stop, fresh, button, announce);
  await shareDepartureSummary(arrival, stop, fresh, button, announce);
  expect(writeText).toHaveBeenCalledTimes(1);
  finish();
  await pending;
  expect(button.disabled).toBe(false);
});
