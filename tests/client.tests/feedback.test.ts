/** @jest-environment jsdom */
import { showModal } from '../../client/scripts/utils/modal';
import { showToast } from '../../client/scripts/utils/toast';

beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = `<main><button id="trigger">Action</button></main>
    <div id="existing-inert" inert></div>
    <div id="message-modal" inert><div role="dialog" aria-modal="true">
    <h2 id="modal-title"></h2><p id="modal-message"></p>
    <button id="modal-ok">OK</button></div></div>`;
  document.getElementById('trigger')!.focus();
});

afterEach(() => {
  document.getElementById('modal-ok')!.click();
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  document.body.replaceChildren();
});

test('message dialog keeps focus inside and Escape restores its trigger and background', () => {
  const trigger = document.activeElement;
  showModal('Unable to load', 'Try again.');
  const ok = document.getElementById('modal-ok')!;
  expect(document.activeElement).toBe(ok);
  expect(document.querySelector('main')!.hasAttribute('inert')).toBe(true);
  const tab = new KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true
  });
  ok.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(true);
  ok.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  expect(document.activeElement).toBe(trigger);
  expect(document.querySelector('main')!.hasAttribute('inert')).toBe(false);
  expect(document.getElementById('existing-inert')!.hasAttribute('inert')).toBe(
    true
  );
});

test('replacing a dialog keeps its original focus destination and renders text safely', () => {
  const trigger = document.activeElement;
  showModal('First', 'Original');
  showModal('Second', '<img src=x onerror=alert(1)>');
  expect(
    document.getElementById('modal-message')!.querySelector('img')
  ).toBeNull();
  document.getElementById('modal-ok')!.click();
  expect(document.activeElement).toBe(trigger);
  expect(document.querySelector('main')!.hasAttribute('inert')).toBe(false);
});

test('optional retry follows OK in the focus loop and closes the modal before running its action', () => {
  const trigger = document.activeElement;
  const action = jest.fn(() => {
    expect(
      document.getElementById('message-modal')!.classList.contains('is-open')
    ).toBe(false);
    expect(document.querySelector('main')!.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
  showModal('Stop unavailable', 'Check your connection.', {
    label: 'Try again',
    action
  });
  const ok = document.getElementById('modal-ok')!;
  const retry = ok.nextElementSibling as HTMLButtonElement;
  expect(retry.textContent).toBe('Try again');
  expect(document.activeElement).toBe(ok);
  const tab = (target: HTMLElement, shiftKey = false) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey,
        bubbles: true,
        cancelable: true
      })
    );
  tab(ok);
  expect(document.activeElement).toBe(retry);
  tab(retry);
  expect(document.activeElement).toBe(ok);
  tab(ok, true);
  expect(document.activeElement).toBe(retry);
  retry.click();
  expect(action).toHaveBeenCalledTimes(1);
  expect(retry.isConnected).toBe(false);
  retry.click();
  expect(action).toHaveBeenCalledTimes(1);
});

test('Escape and OK dismiss retry dialogs without invoking the optional action', () => {
  const action = jest.fn();
  const trigger = document.activeElement;
  showModal('Unavailable', 'Try later.', { label: 'Try again', action });
  const retry = document.querySelector<HTMLButtonElement>(
    '.modal-btn--secondary'
  )!;
  retry.focus();
  retry.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  expect(document.activeElement).toBe(trigger);
  expect(action).not.toHaveBeenCalled();
  showModal('Unavailable', 'Try later.', { label: 'Try again', action });
  document.getElementById('modal-ok')!.click();
  expect(action).not.toHaveBeenCalled();
  expect(document.querySelector('.modal-btn--secondary')).toBeNull();
});

test('replacement dialogs discard prior retry handlers and render action labels as inert text', () => {
  const staleAction = jest.fn();
  showModal('First', 'Failed.', {
    label: '<img src=x onerror=alert(1)>',
    action: staleAction
  });
  const staleButton = document.querySelector<HTMLButtonElement>(
    '.modal-btn--secondary'
  )!;
  expect(staleButton.querySelector('img')).toBeNull();
  showModal('Second', 'Standard message.');
  expect(document.querySelectorAll('#message-modal button')).toHaveLength(1);
  staleButton.click();
  expect(staleAction).not.toHaveBeenCalled();
});

test('a retry action can open its own dialog without the previous cleanup making it inert', () => {
  const trigger = document.activeElement;
  showModal('First', 'Failed.', {
    label: 'Retry',
    action: () => showModal('Retry result', 'Still unavailable.')
  });
  document.querySelector<HTMLButtonElement>('.modal-btn--secondary')!.click();
  expect(
    document.getElementById('message-modal')!.classList.contains('is-open')
  ).toBe(true);
  expect(document.getElementById('message-modal')!.hasAttribute('inert')).toBe(
    false
  );
  expect(document.getElementById('modal-title')!.textContent).toBe(
    'Retry result'
  );
  expect(document.activeElement).toBe(document.getElementById('modal-ok'));
  document.getElementById('modal-ok')!.click();
  expect(document.activeElement).toBe(trigger);
});

test('new feedback replaces the old toast with its own full timeout', () => {
  showToast('First');
  jest.advanceTimersByTime(4000);
  showToast('Second');
  expect(document.querySelectorAll('.toast-notification')).toHaveLength(1);
  expect(
    document.querySelector('.toast-notification [role="status"]')!.textContent
  ).toBe('Second');
  jest.advanceTimersByTime(1000);
  expect(document.querySelector('.toast-notification')).not.toBeNull();
  jest.advanceTimersByTime(4000);
  expect(document.querySelector('.toast-notification')).toBeNull();
});

test('toast waits while hovered or focused and allows manual dismissal without losing focus', () => {
  const trigger = document.activeElement;
  showToast('Saved');
  const toast = document.querySelector<HTMLElement>('.toast-notification')!;
  toast.dispatchEvent(new Event('mouseenter'));
  jest.advanceTimersByTime(6000);
  expect(toast.isConnected).toBe(true);
  toast.querySelector<HTMLButtonElement>('button')!.focus();
  toast.dispatchEvent(new Event('mouseleave'));
  jest.advanceTimersByTime(6000);
  expect(toast.isConnected).toBe(true);
  toast.querySelector<HTMLButtonElement>('button')!.click();
  expect(toast.isConnected).toBe(false);
  expect(document.activeElement).toBe(trigger);
});
