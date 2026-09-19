/** @jest-environment jsdom */

import '../../client/scripts/components/transit-search';

const mockFetch = jest.fn();
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function response(name: string) {
  return {
    ok: true,
    json: async () => ({
      payload: { routes: [{ id: '61D', name }], stops: [] }
    })
  };
}

describe('transit search request ownership and keyboard access', () => {
  let component: HTMLElement;
  let input: HTMLInputElement;
  beforeEach(() => {
    global.fetch = mockFetch;
    mockFetch.mockReset();
    document.body.innerHTML = '<transit-search></transit-search>';
    component = document.querySelector('transit-search')!;
    input = component.querySelector('input')!;
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });
  function search(value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  test('clearing a query prevents its pending results from reopening the dropdown', async () => {
    let resolve!: (value: unknown) => void;
    mockFetch.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    search('old');
    component.querySelector<HTMLButtonElement>('#search-clear-btn')!.click();
    resolve(response('Old result'));
    await flush();
    expect(
      component.querySelector<HTMLElement>('#search-dropdown')!.hidden
    ).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  test('latest results win and route data is rendered as text', async () => {
    let resolveOld!: (value: unknown) => void;
    mockFetch.mockReturnValueOnce(
      new Promise((r) => {
        resolveOld = r;
      })
    );
    mockFetch.mockResolvedValueOnce(response('<img src=x onerror=alert(1)>'));
    search('old');
    search('new');
    await flush();
    resolveOld(response('Old result'));
    await flush();
    expect(component.querySelector('img')).toBeNull();
    expect(component.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(component.textContent).not.toContain('Old result');
  });

  test('arrow keys and Enter select a route without a pointer', async () => {
    mockFetch.mockResolvedValue(response('Murray'));
    const onSelect = jest.fn();
    component.addEventListener('searchSelectRoute', onSelect);
    search('61');
    await flush();
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    const option = component.querySelector<HTMLElement>('[role="option"]')!;
    expect(document.activeElement).toBe(option);
    option.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    await flush();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].detail.routeId).toBe('61D');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });
});
