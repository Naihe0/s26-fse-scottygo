/** @jest-environment jsdom */
import { PlaceSuggestions } from '../../client/scripts/components/place-suggestions';
import { LocationSearch } from '../../client/scripts/components/location-search';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function suggestion(label = 'Campus Library') {
  const place = {
    location: { lat: () => 40.444, lng: () => -79.943 },
    displayName: label,
    formattedAddress: 'Pittsburgh',
    fetchFields: jest.fn().mockResolvedValue({})
  };
  return {
    place,
    entry: {
      placePrediction: { text: { toString: () => label }, toPlace: () => place }
    }
  };
}

describe('Places New search and selection lifecycle', () => {
  const originalGoogle = globalThis.google;
  let input: HTMLInputElement;
  let picker: PlaceSuggestions;
  let choose: jest.Mock;
  let fetchSuggestions: jest.Mock;
  let importLibrary: jest.Mock;
  let sessionToken: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '<form><label>Place<input></label></form>';
    input = document.querySelector('input')!;
    choose = jest.fn();
    fetchSuggestions = jest
      .fn()
      .mockResolvedValue({ suggestions: [suggestion().entry] });
    sessionToken = jest.fn().mockImplementation(() => ({}));
    importLibrary = jest.fn().mockResolvedValue({
      AutocompleteSessionToken: sessionToken,
      AutocompleteSuggestion: { fetchAutocompleteSuggestions: fetchSuggestions }
    });
    globalThis.google = { maps: { importLibrary } } as unknown as typeof google;
    picker = new PlaceSuggestions(input, choose);
  });
  afterEach(() => {
    picker.dispose();
    document.body.replaceChildren();
    globalThis.google = originalGoogle;
    jest.useRealTimers();
  });
  function type(value: string) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  async function search(value = 'Campus') {
    type(value);
    jest.advanceTimersByTime(220);
    await flush();
  }
  const status = () => document.querySelector('[role="status"]')!.textContent;
  const buttons = () => [
    ...document.querySelectorAll<HTMLButtonElement>('[data-place-result]')
  ];

  test('debounces typing and presents at most five readable suggestions with explicit empty feedback', async () => {
    type('C');
    jest.advanceTimersByTime(220);
    expect(fetchSuggestions).not.toHaveBeenCalled();
    type('Ca');
    jest.advanceTimersByTime(100);
    type('Campus');
    expect(status()).toBe('Searching places…');
    fetchSuggestions.mockResolvedValueOnce({
      suggestions: Array.from(
        { length: 7 },
        (_, i) => suggestion('Place ' + i).entry
      )
    });
    jest.advanceTimersByTime(220);
    await flush();
    expect(fetchSuggestions).toHaveBeenCalledTimes(1);
    expect(fetchSuggestions.mock.calls[0][0].input).toBe('Campus');
    expect(buttons()).toHaveLength(5);
    fetchSuggestions.mockResolvedValueOnce({ suggestions: [] });
    await search('No known place');
    expect(buttons()).toHaveLength(0);
    expect(status()).toContain('No places found');
  });

  test('ignores a stale suggestion reply and old failure after the rider changes the query', async () => {
    const old = deferred<{ suggestions: unknown[] }>();
    fetchSuggestions.mockReturnValueOnce(old.promise);
    await search('Old query');
    await search('Campus');
    expect(buttons()[0].textContent).toBe('Campus Library');
    old.resolve({ suggestions: [suggestion('Wrong older result').entry] });
    await flush();
    expect(buttons().map((button) => button.textContent)).toEqual([
      'Campus Library'
    ]);
    const failed = deferred<{ suggestions: unknown[] }>();
    fetchSuggestions.mockReturnValueOnce(failed.promise);
    await search('Will fail');
    await search('Latest query');
    failed.reject(new Error('outdated failure'));
    await flush();
    expect(status()).toBe('Choose a place');
  });

  test('cancellation while importing the SDK prevents a request and clears pending debounce', async () => {
    const importing = deferred<unknown>();
    importLibrary.mockReturnValueOnce(importing.promise);
    await search();
    picker.reset();
    importing.resolve({
      AutocompleteSessionToken: sessionToken,
      AutocompleteSuggestion: { fetchAutocompleteSuggestions: fetchSuggestions }
    });
    await flush();
    expect(fetchSuggestions).not.toHaveBeenCalled();
    type('Another');
    picker.reset();
    jest.advanceTimersByTime(300);
    expect(importLibrary).toHaveBeenCalledTimes(1);
    expect(status()).toBe('');
  });

  test.each(['cancel', 'change'])(
    'late place details cannot select after %s',
    async (action) => {
      const result = suggestion('Old place');
      const details = deferred<unknown>();
      result.place.fetchFields.mockReturnValueOnce(details.promise);
      fetchSuggestions.mockResolvedValueOnce({ suggestions: [result.entry] });
      await search();
      buttons()[0].click();
      expect(status()).toBe('Opening place…');
      if (action === 'cancel') picker.reset();
      else type('New place');
      details.resolve({});
      await flush();
      expect(choose).not.toHaveBeenCalled();
    }
  );

  test('shows searchable inline failure and does not choose a place with missing coordinates', async () => {
    fetchSuggestions.mockRejectedValueOnce(new Error('provider down'));
    await search();
    expect(status()).toContain('Place search is unavailable');
    const result = suggestion();
    Object.assign(result.place, { location: null });
    fetchSuggestions.mockResolvedValueOnce({ suggestions: [result.entry] });
    await search('Try again');
    buttons()[0].click();
    await flush();
    expect(status()).toContain('Could not open this place');
    expect(choose).not.toHaveBeenCalled();
    await search('Library');
    buttons()[0].click();
    await flush();
    expect(choose).toHaveBeenCalledWith(40.444, -79.943, 'Campus Library');
  });

  test('arrow keys navigate results and Enter selects without submitting the surrounding form', async () => {
    const result = suggestion('<img src=x>');
    fetchSuggestions.mockResolvedValueOnce({
      suggestions: [result.entry, suggestion('Second place').entry]
    });
    await search();
    expect(document.querySelector('img')).toBeNull();
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true
      })
    );
    expect(document.activeElement).toBe(buttons()[0]);
    buttons()[0].dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true
      })
    );
    expect(document.activeElement).toBe(buttons()[1]);
    buttons()[1].dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true
      })
    );
    buttons()[0].dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true
      })
    );
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true })
    );
    expect(choose).not.toHaveBeenCalled();
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true
    });
    expect(input.dispatchEvent(enter)).toBe(false);
    await flush();
    expect(choose).toHaveBeenCalledWith(40.444, -79.943, '<img src=x>');
    expect(result.place.fetchFields).toHaveBeenCalledWith({
      fields: ['location', 'displayName', 'formattedAddress']
    });
  });

  test('reuses a token through one search series then starts fresh after a selection or reset and disposes listeners', async () => {
    await search('Carnegie');
    await search('Carnegie Library');
    expect(sessionToken).toHaveBeenCalledTimes(1);
    expect(fetchSuggestions.mock.calls[0][0].sessionToken).toBe(
      fetchSuggestions.mock.calls[1][0].sessionToken
    );
    buttons()[0].click();
    await flush();
    await search('Airport');
    expect(sessionToken).toHaveBeenCalledTimes(2);
    picker.reset();
    await search('Campus');
    expect(sessionToken).toHaveBeenCalledTimes(3);
    picker.dispose();
    type('After disconnect');
    jest.advanceTimersByTime(300);
    await flush();
    expect(sessionToken).toHaveBeenCalledTimes(3);
    expect(document.querySelector('.place-suggestions')).toBeNull();
  });

  test('a tapped suggestion stays inside the location picker while its removed button awaits place details', async () => {
    picker.dispose();
    document.body.replaceChildren();
    const location = new LocationSearch();
    document.body.append(location);
    location.setMap({} as google.maps.Map);
    const chosen = jest.fn();
    location.pick(chosen);
    location.querySelector<HTMLElement>('.location-search-custom')!.click();
    input = location.querySelector<HTMLInputElement>('.location-search-places-input')!;
    const result = suggestion();
    const details = deferred<unknown>();
    result.place.fetchFields.mockReturnValueOnce(details.promise);
    fetchSuggestions.mockResolvedValueOnce({ suggestions: [result.entry] });
    await search();
    const target = buttons()[0];
    target.click();
    expect(target.isConnected).toBe(false);
    expect(chosen).not.toHaveBeenCalled();
    expect(location.querySelector<HTMLElement>('.location-search-dropdown')!.hidden).toBe(false);
    details.resolve({});
    await flush();
    expect(chosen).toHaveBeenCalledWith({ lat: 40.444, lng: -79.943, label: 'Campus Library' });
    location.remove();
  });
});
