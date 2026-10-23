/** @jest-environment jsdom */
import { TransitSearch } from '../../client/scripts/components/transit-search';
import '../../client/scripts/components/transit-search';

const mockFetch = jest.fn();
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function response(name: string) {
  return {
    ok: true,
    json: async () => ({
      payload: { routes: [{ id: '61D', name, system: 'PRT' }], stops: [] }
    })
  };
}
function mixedResponse() {
  return {
    ok: true,
    json: async () => ({
      payload: {
        routes: [{ id: '61D', name: 'Murray', system: 'PRT' }],
        stops: [
          {
            stopId: '123',
            stopName: 'Forbes Ave at Morewood Ave',
            lat: 40.4,
            lon: -79.9,
            routes: ['61D']
          }
        ]
      }
    })
  };
}

describe('transit search feedback and keyboard navigation', () => {
  let component: TransitSearch;
  let input: HTMLInputElement;
  let dropdown: HTMLElement;
  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = mockFetch;
    mockFetch.mockReset();
    document.body.innerHTML = '<transit-search></transit-search>';
    component = document.querySelector('transit-search')!;
    input = component.querySelector('input')!;
    dropdown = component.querySelector('#search-dropdown')!;
    input.focus();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    jest.useRealTimers();
  });
  function type(value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  async function search(value: string): Promise<void> {
    type(value);
    jest.advanceTimersByTime(220);
    await flush();
  }
  function press(key: string): void {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }

  test('shows immediate progress and combines rapid typing into one request', async () => {
    mockFetch.mockResolvedValue(response('Murray'));
    type('6');
    jest.advanceTimersByTime(100);
    type('61');
    jest.advanceTimersByTime(100);
    type('61D');
    expect(dropdown.hidden).toBe(false);
    expect(dropdown.textContent).toContain('Searching…');
    expect(dropdown.getAttribute('aria-busy')).toBe('true');
    expect(mockFetch).not.toHaveBeenCalled();
    jest.advanceTimersByTime(220);
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('/search?q=61D');
    expect(dropdown.getAttribute('aria-busy')).toBe('false');
  });

  test('typing a new query immediately removes old selectable results', async () => {
    mockFetch.mockResolvedValue(response('Murray'));
    await search('61');
    expect(component.querySelector('[role="option"]')).not.toBeNull();
    type('Forbes');
    expect(component.querySelector('[role="option"]')).toBeNull();
    expect(dropdown.textContent).toContain('Searching…');
  });

  test('clearing aborts the request and prevents late results reopening the dropdown', async () => {
    let resolve!: (value: unknown) => void;
    mockFetch.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    await search('old');
    const signal = mockFetch.mock.calls[0][1].signal as AbortSignal;
    component.querySelector<HTMLButtonElement>('#search-clear-btn')!.click();
    expect(signal.aborted).toBe(true);
    resolve(response('Old result'));
    await flush();
    expect(dropdown.hidden).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.value).toBe('');
  });

  test('latest results win even when an aborted request resolves; data stays text', async () => {
    let resolveOld!: (value: unknown) => void;
    mockFetch.mockReturnValueOnce(
      new Promise((r) => {
        resolveOld = r;
      })
    );
    mockFetch.mockResolvedValueOnce(response('<img src=x onerror=alert(1)>'));
    await search('old');
    const oldSignal = mockFetch.mock.calls[0][1].signal as AbortSignal;
    await search('new');
    expect(oldSignal.aborted).toBe(true);
    resolveOld(response('Old result'));
    await flush();
    expect(component.querySelector('img')).toBeNull();
    expect(component.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(component.textContent).not.toContain('Old result');
  });

  test('groups routes and stops and announces the number of results', async () => {
    mockFetch.mockResolvedValue(mixedResponse());
    await search('Forbes');
    expect(
      component.querySelector(
        '[role="group"][aria-label="Routes"] [data-route-id="61D"]'
      )
    ).not.toBeNull();
    expect(
      component.querySelector(
        '[role="group"][aria-label="Stops"] [data-stop-id="123"]'
      )
    ).not.toBeNull();
    expect(
      component.querySelector('.search-announcement')!.textContent
    ).toContain('2 results');
    expect(input.getAttribute('aria-controls')).toBe('search-results');
  });

  test('arrow keys keep input focused and Enter selects the highlighted stop once', async () => {
    mockFetch.mockResolvedValue(mixedResponse());
    const onSelect = jest.fn();
    component.addEventListener('searchSelectStop', onSelect);
    await search('Forbes');
    press('ArrowDown');
    press('ArrowDown');
    expect(document.activeElement).toBe(input);
    const selected = component.querySelector(
      '[role="option"][aria-selected="true"]'
    )!;
    expect(selected.getAttribute('data-stop-id')).toBe('123');
    expect(input.getAttribute('aria-activedescendant')).toBe(selected.id);
    press('Enter');
    await flush();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].detail.stop.stopId).toBe('123');
    expect(document.activeElement).toBe(input);
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(dropdown.hidden).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('ArrowUp starts at the last option and wraps without moving the caret', async () => {
    mockFetch.mockResolvedValue(mixedResponse());
    await search('Forbes');
    input.setSelectionRange(2, 2);
    press('ArrowUp');
    expect(input.getAttribute('aria-activedescendant')).toBe('search-option-1');
    press('ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe('search-option-0');
    expect(input.selectionStart).toBe(2);
  });

  test('Enter starts a pending search immediately and selects the first ready result', async () => {
    mockFetch.mockResolvedValue(response('Murray'));
    const onSelect = jest.fn();
    component.addEventListener('searchSelectRoute', onSelect);
    type('61D');
    press('Enter');
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    press('Enter');
    expect(onSelect.mock.calls[0][0].detail.routeId).toBe('61D');
    jest.advanceTimersByTime(220);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('pointer selection dismisses the keyboard and preserves the selected route event', async () => {
    mockFetch.mockResolvedValue(response('Murray'));
    const onSelect = jest.fn();
    component.addEventListener('searchSelectRoute', onSelect);
    await search('61D');
    component
      .querySelector('[role="option"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(document.activeElement).not.toBe(input);
    expect(onSelect.mock.calls[0][0].detail.routeId).toBe('61D');
    expect(dropdown.hidden).toBe(true);
  });

  test.each(['Escape', 'Tab'])(
    '%s closes results and cancels pending typing without selecting',
    async (key) => {
      mockFetch.mockResolvedValue(response('Murray'));
      const onSelect = jest.fn();
      component.addEventListener('searchSelectRoute', onSelect);
      type('61D');
      press(key);
      jest.advanceTimersByTime(220);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(dropdown.hidden).toBe(true);
      expect(onSelect).not.toHaveBeenCalled();
    }
  );

  test('empty results give useful guidance and escape the query', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ payload: { routes: [], stops: [] } })
    });
    await search('<img src=x>');
    expect(dropdown.textContent).toContain('No matches for “<img src=x>”');
    expect(dropdown.textContent).toContain('Try a route number or stop name.');
    expect(component.querySelector('img')).toBeNull();
    expect(component.querySelector('[role="option"]')).toBeNull();
  });

  test('an error offers a retry that keeps its request alive through the click event', async () => {
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    mockFetch.mockResolvedValueOnce(response('Murray'));
    await search('61D');
    const retry =
      component.querySelector<HTMLButtonElement>('.search-retry-btn')!;
    expect(dropdown.textContent).toContain('Search couldn’t load.');
    retry.focus();
    retry.click();
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(dropdown.hidden).toBe(false);
    expect(component.querySelector('[data-route-id="61D"]')).not.toBeNull();
  });

  test('Tab reaches the retry action and keyboard activation retries the search', async () => {
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    mockFetch.mockResolvedValueOnce(response('Murray'));
    await search('61D');
    press('Tab');
    expect(dropdown.hidden).toBe(false);
    // jsdom does not perform native Tab traversal; follow the actual DOM order.
    component.querySelector<HTMLButtonElement>('#search-clear-btn')!.focus();
    const retry =
      component.querySelector<HTMLButtonElement>('.search-retry-btn')!;
    retry.focus();
    expect(document.activeElement).toBe(retry);
    expect(dropdown.hidden).toBe(false);
    // Native Enter on a button dispatches click with detail 0.
    retry.click();
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(component.querySelector('[data-route-id="61D"]')).not.toBeNull();
  });

  test('moving focus outside search closes the retry state without stealing focus', async () => {
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    await search('61D');
    component.querySelector<HTMLButtonElement>('.search-retry-btn')!.focus();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    expect(dropdown.hidden).toBe(true);
    expect(document.activeElement).toBe(outside);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('a stalled request times out and a late response cannot overwrite the retry state', async () => {
    let resolve!: (value: unknown) => void;
    mockFetch.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    await search('61D');
    const signal = mockFetch.mock.calls[0][1].signal as AbortSignal;
    jest.advanceTimersByTime(10000);
    expect(signal.aborted).toBe(true);
    expect(component.querySelector('.search-retry-btn')).not.toBeNull();
    expect(dropdown.getAttribute('aria-busy')).toBe('false');
    resolve(response('Late result'));
    await flush();
    expect(component.textContent).not.toContain('Late result');
  });

  test('IME composition does not submit intermediate characters or activate Enter', async () => {
    mockFetch.mockResolvedValue(response('Murray'));
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    type('匹');
    press('Enter');
    jest.advanceTimersByTime(500);
    expect(mockFetch).not.toHaveBeenCalled();
    input.value = '匹兹堡';
    input.dispatchEvent(new CompositionEvent('compositionend'));
    jest.advanceTimersByTime(220);
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      `/search?q=${encodeURIComponent('匹兹堡')}`
    );
  });

  test('state synchronization cancels search without moving focus or dispatching a selection', async () => {
    const onSelect = jest.fn();
    component.addEventListener('searchSelectRoute', onSelect);
    type('stale');
    component.setSelection('61D');
    jest.advanceTimersByTime(220);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(input.value).toBe('61D');
    expect(document.activeElement).toBe(input);
    expect(dropdown.hidden).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('disconnecting aborts network work and removes pending search timers', async () => {
    mockFetch.mockReturnValue(new Promise(() => undefined));
    await search('61D');
    const signal = mockFetch.mock.calls[0][1].signal as AbortSignal;
    component.remove();
    expect(signal.aborted).toBe(true);
    jest.advanceTimersByTime(10000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
