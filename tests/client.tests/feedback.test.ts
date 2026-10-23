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
