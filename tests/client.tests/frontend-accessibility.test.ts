/** @jest-environment jsdom */

import '../../client/scripts/components/app-header';
import '../../client/scripts/components/map-controls';
import '../../client/scripts/components/zoom-controls';
import '../../client/scripts/components/toggle-panel';
import type { ITogglePanelElement } from '../../client/scripts/components/toggle-panel';
import '../../client/scripts/components/bus-report-form';
import type {
  BusReportFormElement,
  IBusReportSubmission
} from '../../client/scripts/components/bus-report-form';
import {
  createMapPopup,
  minimizePopup
} from '../../client/scripts/utils/map-popup';

afterEach(() => {
  document.body.innerHTML = '';
});

test('popup headings and minimized tabs treat external stop labels as text', () => {
  document.body.innerHTML = '<div class="map-container"></div>';
  const label = '<img src=x onerror=alert(1)>';
  const { popup } = createMapPopup('stop', 'place', label);
  document.querySelector('.map-container')!.appendChild(popup);
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('.map-popup__title')!.textContent).toBe(label);
  minimizePopup('stop', label, () => undefined, label, '#123456');
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('.map-popup-tab__label')!.textContent).toBe(
    label
  );
  expect(document.querySelector('.map-popup-tab')!.getAttribute('role')).toBe(
    'button'
  );
});

test('an empty report stays open and explains what is missing', () => {
  document.body.innerHTML = '<bus-report-form></bus-report-form>';
  const form = document.querySelector(
    'bus-report-form'
  ) as BusReportFormElement;
  form.open('123', '61D', 40, -79);
  const submitted = jest.fn();
  form.addEventListener('busReportSubmitted', submitted);
  for (let step = 0; step < 4; step++)
    form.querySelector<HTMLButtonElement>('#bus-report-next')!.click();
  expect(submitted).not.toHaveBeenCalled();
  expect(form.classList.contains('is-open')).toBe(true);
  expect(form.querySelector('#bus-report-error')!.textContent).toContain(
    'Choose a bus condition'
  );
});

test('a failed report preserves its draft, prevents duplicate sends, and can be retried', () => {
  document.body.innerHTML = '<bus-report-form></bus-report-form>';
  const form = document.querySelector(
    'bus-report-form'
  ) as BusReportFormElement;
  form.open('123', '61D', 40, -79);
  const submissions: IBusReportSubmission[] = [];
  form.addEventListener('busReportSubmitted', (event) =>
    submissions.push((event as CustomEvent<IBusReportSubmission>).detail)
  );
  for (let step = 0; step < 3; step++)
    form.querySelector<HTMLButtonElement>('#bus-report-next')!.click();
  const comment = form.querySelector<HTMLTextAreaElement>('textarea')!;
  comment.value = 'My report draft';
  comment.dispatchEvent(new Event('input', { bubbles: true }));
  const submit = form.querySelector<HTMLButtonElement>('#bus-report-next')!;
  submit.click();
  submit.dispatchEvent(new Event('click'));
  expect(submissions).toHaveLength(1);
  expect(form.classList.contains('is-open')).toBe(true);
  expect(submit.disabled).toBe(true);
  submissions[0].onError('Network unavailable. Please retry.');
  expect(comment.value).toBe('My report draft');
  expect(submit.disabled).toBe(false);
  expect(form.querySelector('#bus-report-error')!.textContent).toContain(
    'Network unavailable'
  );
  submit.click();
  expect(submissions).toHaveLength(2);
  expect(submissions[1].report.comment).toBe('My report draft');
  submissions[1].onSuccess();
  expect(form.classList.contains('is-open')).toBe(false);
});

test('completion of an old report does not close a newly opened report', () => {
  document.body.innerHTML = '<bus-report-form></bus-report-form>';
  const form = document.querySelector(
    'bus-report-form'
  ) as BusReportFormElement;
  let submission!: IBusReportSubmission;
  form.addEventListener('busReportSubmitted', (event) => {
    submission = (event as CustomEvent<IBusReportSubmission>).detail;
  });
  form.open('123', '61D', 40, -79);
  form.querySelector<HTMLButtonElement>('.bus-report__option')!.click();
  for (let step = 0; step < 4; step++)
    form.querySelector<HTMLButtonElement>('#bus-report-next')!.click();
  form.close();
  form.open('456', '71A', 40, -79);
  submission.onSuccess();
  expect(form.classList.contains('is-open')).toBe(true);
  expect(form.querySelector('.bus-report__subtitle')!.textContent).toContain(
    '456'
  );
});

test('navigation is a named button with state, Escape dismissal, and focus restoration', () => {
  document.body.innerHTML = '<app-header></app-header>';
  const button = document.querySelector<HTMLButtonElement>('#menu-icon')!;
  const menu = document.querySelector('#dropdown-menu')!;
  expect(button.tagName).toBe('BUTTON');
  expect(button.getAttribute('aria-label')).toBeTruthy();
  expect(menu.hasAttribute('inert')).toBe(true);
  button.click();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(menu.hasAttribute('inert')).toBe(false);
  menu.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(button);
  button.click();
  document.body.click();
  expect(button.getAttribute('aria-expanded')).toBe('false');
});

test('generated transit system checkboxes have names matching their option labels', () => {
  document.body.innerHTML = '<toggle-panel></toggle-panel>';
  const panel = document.querySelector('toggle-panel') as ITogglePanelElement;
  panel.configure({
    eventName: 'systemFilterApplied',
    options: [
      {
        id: 'prt',
        label: 'Pittsburgh Regional Transit Routes',
        defaultChecked: true
      },
      { id: 'cmu', label: 'CMU Shuttle Routes', defaultChecked: false }
    ]
  });
  expect(panel.querySelector('#prt')!.getAttribute('aria-label')).toBe(
    'Pittsburgh Regional Transit Routes'
  );
  expect(panel.querySelector('#cmu')!.getAttribute('aria-label')).toBe(
    'CMU Shuttle Routes'
  );
});

test('map filter and zoom icon buttons have meaningful accessible names', () => {
  document.body.innerHTML =
    '<map-controls></map-controls><zoom-controls></zoom-controls>';
  document.querySelectorAll('button').forEach((button) => {
    expect(button.getAttribute('aria-label')).toMatch(/[a-z]/i);
  });
});

test('going back and forward preserves report text without creating HTML elements', () => {
  document.body.innerHTML = '<bus-report-form></bus-report-form>';
  const form = document.querySelector(
    'bus-report-form'
  ) as BusReportFormElement;
  form.open('123', '61D', 40, -79, '<img src=x onerror=alert(1)>');
  const click = (id: string) =>
    form.querySelector<HTMLButtonElement>(id)!.click();
  click('#bus-report-next');
  click('#bus-report-next');
  click('#bus-report-next');
  const textarea = form.querySelector<HTMLTextAreaElement>('textarea')!;
  const payload = '</textarea><img src=x onerror=alert(1)>';
  textarea.value = payload;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  click('#bus-report-back');
  click('#bus-report-next');
  expect(form.querySelector('img')).toBeNull();
  expect(form.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
    payload
  );
});
