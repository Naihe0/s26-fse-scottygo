/**
 * Bus Report Form Component
 * A multi-step modal form for reporting bus conditions.
 *
 * Usage:
 *   const form = document.querySelector('bus-report-form') as BusReportFormElement;
 *   form.open('6551', '71A', 40.4418, -79.9440);
 */

import { escapeHtml } from '../utils/html';

export interface IBusReportSubmission {
  report: Record<string, unknown>;
  onSuccess(): void;
  onError(message: string): void;
}

export interface BusReportFormElement extends HTMLElement {
  open(
    vid: string,
    routeId: string,
    lat: number,
    lon: number,
    routeLabel?: string
  ): void;
  close(): void;
}

interface StepOption {
  label: string;
  value: string;
}

interface Step {
  id: string;
  label: string;
  question: string;
  options: StepOption[];
  wrap: boolean;
}

const STEPS: Step[] = [
  {
    id: 'crowdedness',
    label: 'Crowding',
    question: 'How crowded is the bus?',
    options: [
      { label: 'Empty', value: 'Empty' },
      { label: 'Many seats open', value: 'Few Seats Taken' },
      { label: 'Standing room', value: 'Standing Room' },
      { label: 'Packed', value: 'Packed' }
    ],
    wrap: true
  },
  {
    id: 'prioritySeating',
    label: 'Priority seats',
    question: 'Priority seating available?',
    options: [
      { label: 'Yes', value: 'Available' },
      { label: 'No', value: 'Occupied' },
      { label: 'Not Sure', value: '__NOT_SURE__' }
    ],
    wrap: false
  },
  {
    id: 'condition',
    label: 'Cleanliness',
    question: 'Condition of the bus?',
    options: [
      { label: 'Clean', value: 'Clean' },
      { label: 'Average', value: 'Average' },
      { label: 'Dirty', value: 'Dirty' }
    ],
    wrap: false
  },
  {
    id: 'comment',
    label: 'Comment',
    question: 'Any comments?',
    options: [],
    wrap: false
  }
];

const REVIEW = STEPS.length;

class BusReportForm extends HTMLElement implements BusReportFormElement {
  private currentStep = 0;
  private answers: Record<string, string> = {};
  private vid = '';
  private routeId = '';
  private routeLabel = '';
  private lat = 0;
  private lon = 0;
  private submitting = false;
  private submissionVersion = 0;
  private returnTo: HTMLElement | null = null;
  private editingReview = false;
  private confirmingDiscard = false;

  connectedCallback(): void {
    this.setAttribute('inert', '');
    this.addEventListener('click', this.onClick);
    this.addEventListener('input', this.onInput);
    this.addEventListener('change', this.onChange);
  }

  disconnectedCallback(): void {
    this.removeEventListener('click', this.onClick);
    this.removeEventListener('input', this.onInput);
    this.removeEventListener('change', this.onChange);

    this.submissionVersion++;
  }

  open(
    vid: string,
    routeId: string,
    lat: number,
    lon: number,
    routeLabel?: string
  ): void {
    if (!this.classList.contains('is-open'))
      this.returnTo =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    this.submissionVersion++;
    this.submitting = false;
    this.setAttribute('aria-busy', 'false');
    this.vid = vid;
    this.routeId = routeId;
    this.routeLabel = routeLabel || `Route ${routeId}`;
    this.lat = lat;
    this.lon = lon;
    this.currentStep = 0;
    this.answers = {};
    this.confirmingDiscard = false;
    this.editingReview = false;
    this.removeAttribute('inert');
    this.classList.add('is-open');
    this.render();
  }

  close(): void {
    this.submissionVersion++;
    this.submitting = false;
    this.answers = {};
    this.setAttribute('aria-busy', 'false');
    this.classList.remove('is-open');
    this.setAttribute('inert', '');
    this.replaceChildren();
    if (this.returnTo?.isConnected)
      this.returnTo.focus({ preventScroll: true });
    this.returnTo = null;
  }

  private render(): void {
    this.querySelector('dialog')?.close?.();
    const review = this.currentStep === REVIEW;
    const step = STEPS[this.currentStep];
    const next = review
      ? 'Submit report'
      : this.editingReview || this.currentStep === REVIEW - 1
        ? 'Review report'
        : 'Next';
    const jumpOptions = [...STEPS.map((item) => item.label), 'Review report']
      .map(
        (label, index) =>
          `<option value="${index}" ${index === this.currentStep ? 'selected' : ''}>${label}</option>`
      )
      .join('');
    this.innerHTML = `
      <div class="bus-report-backdrop">
        <dialog class="bus-report" aria-labelledby="report-heading">
          <div class="bus-report__header"><strong class="bus-report__title">Bus report</strong>
            <p class="bus-report__subtitle">Bus ${escapeHtml(this.vid)} · ${escapeHtml(this.routeLabel)}</p>
            <button type="button" class="report-close" data-close aria-label="Close bus report">×</button>
          </div>
          ${
            this.confirmingDiscard
              ? `<h2 id="report-heading" tabindex="-1">Discard this report?</h2>
            <p class="bus-report__hint">Your answers have not been sent.</p>
            <div class="bus-report__nav"><button type="button" data-keep>Keep editing</button><button type="button" data-discard>Discard</button></div>`
              : `<label class="report-topic">Report section<select>${jumpOptions}</select></label>
            <div class="bus-report__body">
              <h2 class="bus-report__question" id="report-heading" tabindex="-1">${review ? 'Review your report' : step.question}</h2>
              ${review ? this.reviewRows() : this.stepContent(step)}
            </div>
            <p class="bus-report__error" id="bus-report-error" role="alert" hidden></p>
            <div class="bus-report__nav">
              <button type="button" class="bus-report__nav-btn bus-report__nav-btn--back" id="bus-report-back" ${this.currentStep === 0 && !this.editingReview ? 'disabled' : ''} aria-label="Previous step">‹</button>
              ${review ? '' : '<button type="button" class="bus-report__nav-btn bus-report__nav-btn--skip" id="bus-report-skip">Skip</button>'}
              <button type="button" class="bus-report__nav-btn bus-report__nav-btn--next" id="bus-report-next">${next}</button>
            </div>`
          }
        </dialog>
      </div>`;
    const dialog = this.querySelector('dialog')!;
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (!this.submitting) this.requestClose();
    });
    if (dialog.showModal) dialog.showModal();
    else dialog.open = true;
    this.querySelector<HTMLElement>('#report-heading')?.focus({
      preventScroll: true
    });
  }

  private reviewRows(): string {
    const rows = STEPS.map((step, index) => {
      const answer = this.answers[step.id];
      if (!answer || answer === '__NOT_SURE__') return '';
      const label =
        step.options.find((option) => option.value === answer)?.label ??
        answer.trim();
      return `<li><div><strong>${step.label}</strong><span>${escapeHtml(label)}</span></div><button type="button" data-edit="${index}" aria-label="Edit ${step.label}">Edit</button></li>`;
    });
    return `<ul class="report-review">${rows.join('')}</ul>`;
  }

  private stepContent(step: Step): string {
    if (step.id === 'comment') {
      const saved = this.answers.comment ?? '';
      return `<label for="bus-report-comment">Optional note</label><textarea class="bus-report__textarea" id="bus-report-comment" maxlength="200" placeholder="What should other riders know?">${escapeHtml(saved)}</textarea>
        <p class="bus-report__char-count"><span id="bus-report-char-count">${saved.length}</span> / 200</p>`;
    }
    const options = step.options.map((option) => {
      const selected = this.answers[step.id] === option.value;
      return `<button type="button" class="bus-report__option${selected ? ' bus-report__option--active' : ''}" aria-pressed="${selected}" data-value="${option.value}">${option.label}</button>`;
    });
    return `<div class="bus-report__options bus-report__options--wrap">${options.join('')}</div>`;
  }

  private go(step: number): void {
    if (!Number.isInteger(step) || step < 0 || step > REVIEW) return;
    if (
      step === REVIEW &&
      !Object.values(this.answers).some(
        (answer) => answer.trim() && answer !== '__NOT_SURE__'
      )
    ) {
      const selector = this.querySelector('select');
      if (selector) selector.value = String(this.currentStep);
      this.showError(
        'Choose a bus condition or add a comment before submitting.'
      );
      return;
    }
    this.currentStep = step;
    this.render();
  }

  private requestClose(): void {
    if (this.confirmingDiscard) {
      this.confirmingDiscard = false;
      return this.render();
    }
    if (!Object.keys(this.answers).length) return this.close();
    this.confirmingDiscard = true;
    this.render();
  }

  private onChange = (event: Event): void => {
    if (this.submitting || !(event.target instanceof HTMLSelectElement)) return;
    this.editingReview = false;
    this.go(Number(event.target.value));
  };

  private onInput = (event: Event): void => {
    if (this.submitting || !(event.target instanceof HTMLTextAreaElement))
      return;
    const text = event.target.value;
    if (text.trim()) this.answers.comment = text;
    else delete this.answers.comment;
    const count = this.querySelector('#bus-report-char-count');
    if (count) count.textContent = String(text.length);
    this.hideError();
  };

  private onClick = (event: Event): void => {
    if (this.submitting || !(event.target instanceof Element)) return;
    const button = event.target.closest('button');
    if (!button) {
      if (event.target.classList.contains('bus-report-backdrop'))
        this.requestClose();
      if (
        event.target instanceof HTMLDialogElement &&
        event instanceof MouseEvent
      ) {
        const box = event.target.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          this.requestClose();
      }
      return;
    }
    if (button.hasAttribute('data-close')) return this.requestClose();
    if (button.hasAttribute('data-discard')) return this.close();
    if (button.hasAttribute('data-keep')) {
      this.confirmingDiscard = false;
      return this.render();
    }
    if (button.dataset.edit !== undefined) {
      this.editingReview = true;
      return this.go(Number(button.dataset.edit));
    }

    const step = STEPS[this.currentStep];
    if (button.dataset.value && step) {
      const choice = button.dataset.value;
      if (choice === this.answers[step.id]) delete this.answers[step.id];
      else this.answers[step.id] = choice;
      this.querySelectorAll<HTMLButtonElement>('[data-value]').forEach(
        (option) => {
          const active = option.dataset.value === this.answers[step.id];
          option.classList.toggle('bus-report__option--active', active);
          option.setAttribute('aria-pressed', String(active));
        }
      );
      this.hideError();
      return;
    }

    if (button.id === 'bus-report-back') {
      const previous = this.editingReview ? REVIEW : this.currentStep - 1;
      this.editingReview = false;
      return this.go(previous);
    }
    if (button.id !== 'bus-report-skip' && button.id !== 'bus-report-next')
      return;
    if (this.currentStep === REVIEW) return this.submitReport();
    if (button.id === 'bus-report-skip') delete this.answers[step.id];
    const next = this.editingReview ? REVIEW : this.currentStep + 1;
    this.editingReview = false;
    // Repaint skipped answers even if the empty report cannot enter review.
    if (button.id === 'bus-report-skip') this.render();
    this.go(next);
  };

  private submitReport(): void {
    if (this.submitting) return;
    const { crowdedness, prioritySeating, condition, comment } = this.answers;
    const normalizedPrioritySeating =
      prioritySeating === '__NOT_SURE__' ? undefined : prioritySeating;
    const normalizedComment = comment?.trim();
    if (
      !crowdedness &&
      !normalizedPrioritySeating &&
      !condition &&
      !normalizedComment
    ) {
      this.showError(
        'Choose a bus condition or add a comment before submitting.'
      );
      return;
    }

    const payload: Record<string, unknown> = {
      vid: this.vid,
      routeId: this.routeId,
      lat: this.lat,
      lon: this.lon
    };
    if (crowdedness) payload.crowdedness = crowdedness;
    if (normalizedPrioritySeating)
      payload.prioritySeating = normalizedPrioritySeating;
    if (condition) payload.condition = condition;
    if (normalizedComment) payload.comment = normalizedComment;

    this.submitting = true;
    const version = ++this.submissionVersion;
    this.setSubmissionBusy(true);
    const detail: IBusReportSubmission = {
      report: payload,
      onSuccess: () => {
        if (version === this.submissionVersion) this.close();
      },
      onError: (message) => {
        if (version !== this.submissionVersion) return;
        this.submitting = false;
        this.setSubmissionBusy(false);
        this.showError(message);
      }
    };
    this.dispatchEvent(
      new CustomEvent('busReportSubmitted', { detail, bubbles: true })
    );
  }

  private setSubmissionBusy(busy: boolean): void {
    this.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
      'button, textarea, select'
    ).forEach((control) => {
      control.disabled = busy;
    });
    this.setAttribute('aria-busy', String(busy));
    const submit = this.querySelector('#bus-report-next');
    if (submit) submit.textContent = busy ? 'Submitting...' : 'Submit report';
  }

  private showError(message: string): void {
    const el = this.querySelector<HTMLElement>('#bus-report-error');
    if (el) {
      el.textContent = message;
      el.hidden = false;
    }
  }

  private hideError(): void {
    const el = this.querySelector<HTMLElement>('#bus-report-error');
    if (el) el.hidden = true;
  }
}

customElements.define('bus-report-form', BusReportForm);
