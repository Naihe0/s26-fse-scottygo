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
  question: string;
  options: StepOption[];
  wrap: boolean;
}

const STEPS: Step[] = [
  {
    id: 'crowdedness',
    question: 'How crowded is the bus?',
    options: [
      { label: 'Empty', value: 'Empty' },
      { label: 'Few Seats', value: 'Few Seats Taken' },
      { label: 'Standing', value: 'Standing Room' },
      { label: 'Packed', value: 'Packed' }
    ],
    wrap: true
  },
  {
    id: 'prioritySeating',
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
    question: 'Any comments?',
    options: [],
    wrap: false
  }
];

const TOTAL_STEPS = STEPS.length;

class BusReportForm extends HTMLElement implements BusReportFormElement {
  private currentStep = 1;
  private answers: Record<string, string> = {};
  private vid = '';
  private routeId = '';
  private routeLabel = '';
  private lat = 0;
  private lon = 0;
  private rootListenersAttached = false;
  private submitting = false;
  private submissionVersion = 0;

  connectedCallback(): void {
    this.render();
    this.setupListeners();
    this.setAttribute('inert', '');
  }

  open(
    vid: string,
    routeId: string,
    lat: number,
    lon: number,
    routeLabel?: string
  ): void {
    this.submissionVersion++;
    this.submitting = false;
    this.setAttribute('aria-busy', 'false');
    this.vid = vid;
    this.routeId = routeId;
    this.routeLabel = routeLabel || `Route ${routeId}`;
    this.lat = lat;
    this.lon = lon;
    this.currentStep = 1;
    this.answers = {};
    this.render();
    this.setupListeners();
    this.removeAttribute('inert');
    this.classList.add('is-open');
  }

  close(): void {
    this.submissionVersion++;
    this.submitting = false;
    this.setAttribute('aria-busy', 'false');
    this.classList.remove('is-open');
    this.setAttribute('inert', '');
  }

  private render(): void {
    const step = STEPS[this.currentStep - 1];
    const isFirstStep = this.currentStep === 1;
    const isLastStep = this.currentStep === TOTAL_STEPS;

    this.innerHTML = `
      <div class="bus-report-backdrop">
        <div class="bus-report" role="dialog" aria-modal="true" aria-label="Bus Report">
          <div class="bus-report__header">
            <strong class="bus-report__title">Bus Report</strong>
            <p class="bus-report__subtitle">Bus ${escapeHtml(this.vid)} &middot; ${escapeHtml(this.routeLabel)}</p>
          </div>
          <div class="bus-report__progress">
            ${Array.from(
              { length: TOTAL_STEPS },
              (_, i) =>
                `<div class="bus-report__bar${i < this.currentStep ? ' bus-report__bar--filled' : ''}"></div>`
            ).join('')}
          </div>
          <div class="bus-report__body">
            ${this.renderStepContent(step)}
          </div>
          <p class="bus-report__error" id="bus-report-error" role="alert" style="display:none;color:var(--color-error,#d32f2f);font-size:0.85rem;text-align:center;margin:0 0 0.5rem"></p>
          <div class="bus-report__nav">
            <button
              type="button"
              class="bus-report__nav-btn bus-report__nav-btn--back"
              id="bus-report-back"
              ${isFirstStep ? 'disabled' : ''}
              aria-label="Previous step"
            >&#8249;</button>
            <button type="button" class="bus-report__nav-btn bus-report__nav-btn--skip" id="bus-report-skip">Skip</button>
            <button type="button" class="bus-report__nav-btn bus-report__nav-btn--next" id="bus-report-next">
              ${isLastStep ? 'Submit' : 'Next &#8250;'}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderStepContent(step: Step): string {
    if (step.id === 'comment') {
      const saved = this.answers['comment'] ?? '';
      return `
        <p class="bus-report__question">${step.question}</p>
        <p class="bus-report__hint">Optional &middot; max 200 characters</p>
        <textarea
          class="bus-report__textarea"
          id="bus-report-comment"
          placeholder="Add a note..."
          maxlength="200"
        >${escapeHtml(saved)}</textarea>
        <p class="bus-report__char-count"><span id="bus-report-char-count">${saved.length}</span> / 200</p>
      `;
    }

    const selected = this.answers[step.id];
    const optionsHtml = step.options
      .map((opt) => {
        const isSelected = selected === opt.value;
        const active = isSelected ? ' bus-report__option--active' : '';
        return `<button type="button" class="bus-report__option${active}" data-value="${opt.value}">${opt.label}</button>`;
      })
      .join('');

    return `
      <p class="bus-report__question">${step.question}</p>
      <div class="bus-report__options${step.wrap ? ' bus-report__options--wrap' : ''}">
        ${optionsHtml}
      </div>
    `;
  }

  private setupListeners(): void {
    if (!this.rootListenersAttached) {
      // Option selection
      this.addEventListener('click', (e: Event) => {
        const target = e.target as HTMLElement;
        const option = target.closest<HTMLElement>('.bus-report__option');
        if (!option) return;

        const step = STEPS[this.currentStep - 1];
        const selectedValue = option.dataset.value;
        if (!selectedValue) return;

        this.answers[step.id] = selectedValue;
        this.querySelectorAll('.bus-report__option').forEach((btn) =>
          btn.classList.remove('bus-report__option--active')
        );
        option.classList.add('bus-report__option--active');
        this.hideError();
      });

      // Char counter for comment step
      this.addEventListener('input', (e: Event) => {
        const textarea = e.target as HTMLTextAreaElement;
        if (textarea.id === 'bus-report-comment') {
          const counter = this.querySelector('#bus-report-char-count');
          if (counter) counter.textContent = String(textarea.value.length);
          if (textarea.value.trim()) {
            this.answers['comment'] = textarea.value;
          } else {
            delete this.answers['comment'];
          }
          this.hideError();
        }
      });

      this.rootListenersAttached = true;
    }

    // Back
    this.querySelector('#bus-report-back')?.addEventListener('click', () => {
      if (this.currentStep > 1) {
        this.currentStep--;
        this.render();
        this.setupListeners();
      }
    });

    // Skip
    this.querySelector('#bus-report-skip')?.addEventListener('click', () => {
      this.advanceOrSubmit();
    });

    // Next / Submit
    this.querySelector('#bus-report-next')?.addEventListener('click', () => {
      if (this.currentStep === TOTAL_STEPS) {
        this.submitReport();
      } else {
        this.advanceOrSubmit();
      }
    });

    // Close on backdrop click
    this.querySelector('.bus-report-backdrop')?.addEventListener(
      'click',
      (e: Event) => {
        if (e.target === e.currentTarget) this.close();
      }
    );
  }

  private advanceOrSubmit(): void {
    if (this.currentStep < TOTAL_STEPS) {
      this.currentStep++;
      this.render();
      this.setupListeners();
    } else {
      this.submitReport();
    }
  }

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
      'button, textarea'
    ).forEach((control) => {
      control.disabled = busy;
    });
    this.setAttribute('aria-busy', String(busy));
    const submit = this.querySelector('#bus-report-next');
    if (submit) submit.textContent = busy ? 'Submitting...' : 'Submit';
  }

  private showError(message: string): void {
    const el = this.querySelector<HTMLElement>('#bus-report-error');
    if (el) {
      el.textContent = message;
      el.style.display = 'block';
    }
  }

  private hideError(): void {
    const el = this.querySelector<HTMLElement>('#bus-report-error');
    if (el) el.style.display = 'none';
  }
}

customElements.define('bus-report-form', BusReportForm);
