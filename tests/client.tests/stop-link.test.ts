/** @jest-environment jsdom */
import {
  buildStopLink,
  copyStopLink,
  parseStopLink
} from '../../client/scripts/utils/stop-link';
import { copyViewLink } from '../../client/scripts/utils/copy-view-link';
jest.mock('../../client/scripts/utils/copy-view-link', () => ({
  copyViewLink: jest.fn()
}));

describe('public stop links', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '<button>Share</button>';
  });

  test('contains only the selected stop ID, removing private URL state', () => {
    const link = buildStopLink(
      'cmu:123-4',
      'https://user:password@example.com/private?token=secret#/map?r=61C&lat=40&lng=-80'
    );
    expect(link).toBe('https://example.com/#/map?stop=cmu%3A123-4');
    expect(parseStopLink(new URL(link!).hash)).toBe('cmu:123-4');
  });

  test.each(['', '../stop', 'a b', '<img>', 'x'.repeat(121)])(
    'rejects invalid stop ID %s',
    (id) => {
      expect(buildStopLink(id, 'https://example.com')).toBeNull();
      expect(parseStopLink(`#/map?stop=${encodeURIComponent(id)}`)).toBeNull();
    }
  );

  test('ignores external redirect and duplicate stop values', () => {
    expect(parseStopLink('#/map?stop=123&stop=456')).toBeNull();
    expect(parseStopLink('#/elsewhere?stop=123')).toBeNull();
    expect(buildStopLink('123', 'javascript:alert(1)')).toBeNull();
    expect(buildStopLink('123', 'not-a-url')).toBeNull();
  });

  test('reuses the clipboard fallback with stop-specific wording', async () => {
    jest
      .mocked(copyViewLink)
      .mockImplementation(async (_link, _button, announce) => {
        const dialog = document.createElement('dialog');
        dialog.id = 'copy-view-link-dialog';
        dialog.innerHTML = '<h2>View</h2><p>Route state</p><label>Link</label>';
        document.body.append(dialog);
        announce('Copy was unavailable. Select and copy the view link below.');
      });
    const announce = jest.fn();
    await copyStopLink('123', document.querySelector('button')!, announce);
    expect(copyViewLink).toHaveBeenCalledTimes(1);
    expect(document.querySelector('dialog h2')!.textContent).toBe(
      'Copy stop link'
    );
    expect(document.querySelector('dialog p')!.textContent).toContain(
      'Share this stop'
    );
  });

  test('announces copied stops and rejects invalid IDs before clipboard access', async () => {
    jest
      .mocked(copyViewLink)
      .mockImplementation(async (_link, _button, announce) =>
        announce('View link copied. Your location is not included.')
      );
    const announce = jest.fn();
    await copyStopLink('123', document.querySelector('button')!, announce);
    expect(announce).toHaveBeenCalledWith(
      'Stop link copied. Your location is not included.'
    );
    await copyStopLink('../bad', document.querySelector('button')!, announce);
    expect(copyViewLink).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('This stop cannot be shared yet.');
  });
});
