import type { ILatLng } from '../../../common/map.interface';
import { copyStopLink } from '../utils/stop-link';
import {
  clearRecentShortcuts,
  getRiderShortcuts,
  removeShortcut,
  renameShortcut,
  saveFilterView,
  savePlace,
  subscribeRiderShortcuts,
  SavedPlace,
  SavedStop,
  SavedView,
  ShortcutFilters,
  ShortcutResult
} from '../utils/rider-shortcuts';

type Tab = 'stops' | 'places' | 'recent' | 'views';
export interface RiderShortcutsContext {
  getOrigin(): (ILatLng & { label?: string }) | null;
  getFilters(): ShortcutFilters;
  onSelectStop(stop: SavedStop): void;
  onSelectRoute(routeId: string): void;
  onSelectPlace(place: SavedPlace): void;
  onApplyFilters(filters: ShortcutFilters): void;
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'stops', label: 'Saved stops' },
  { id: 'places', label: 'Places' },
  { id: 'recent', label: 'Recent' },
  { id: 'views', label: 'Views' }
];

function button(
  label: string,
  action: () => void,
  className = ''
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.addEventListener('click', action);
  return element;
}

/** Browser-local commute shortcuts, kept separate from server route subscriptions. */
export class RiderShortcuts extends HTMLElement {
  private context: RiderShortcutsContext | null = null;
  private dialog: HTMLDialogElement | null = null;
  private activeTab: Tab = 'stops';
  private unsubscribe: (() => void) | null = null;
  private returnFocus: HTMLElement | null = null;

  connectedCallback(): void {
    if (!this.dialog) this.build();
    this.unsubscribe?.();
    this.unsubscribe = subscribeRiderShortcuts((accountChanged) => {
      if (accountChanged) {
        this.close();
        return;
      }
      // Background recents/storage updates must not replace a naming field mid-edit.
      if (this.dialog?.open && !this.isEditing()) this.renderPanel();
    });
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.dialog?.open) this.dialog.close();
  }

  configure(context: RiderShortcutsContext): void {
    this.context = context;
    if (this.dialog?.open) this.renderPanel();
  }

  open(tab: Tab = 'stops'): void {
    if (!this.dialog) this.build();
    this.activeTab = tab;
    this.returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.renderPanel();
    this.status('');
    if (!this.dialog!.open) this.dialog!.showModal();
    this.focusTab();
  }

  close(): void {
    this.dialog?.close();
    if (this.returnFocus?.isConnected) this.returnFocus.focus();
  }

  private build(): void {
    this.innerHTML = '';
    const trigger = button(
      'My places',
      () => this.open(),
      'rider-tools-button rider-shortcuts__trigger'
    );
    trigger.setAttribute('aria-haspopup', 'dialog');
    const icon = document.createElement('span');
    icon.className = 'material-icons-outlined';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'bookmarks';
    trigger.prepend(icon);
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'rider-shortcuts-dialog';
    this.dialog.setAttribute('aria-labelledby', 'rider-shortcuts-title');
    this.dialog.innerHTML =
      '<header class="rider-shortcuts__header"><div><h2 id="rider-shortcuts-title">My places</h2><p>Your everyday stops and map views.</p></div><button type="button" class="rider-shortcuts__close" aria-label="Close My places">×</button></header><div class="rider-shortcuts__tabs" role="tablist" aria-label="My places sections"></div><div id="rider-shortcuts-panel" class="rider-shortcuts__panel" role="tabpanel"></div><p class="rider-shortcuts__status" role="status" aria-live="polite"></p><p class="rider-shortcuts__privacy">Stored in this browser, separately for each account. Saved places include locations you choose to save.</p>';
    this.dialog
      .querySelector('.rider-shortcuts__close')!
      .addEventListener('click', () => this.close());
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    this.dialog.addEventListener('click', (event) => {
      if (event.target !== this.dialog) return;
      const bounds = this.dialog!.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        this.close();
    });
    const tabs = this.dialog.querySelector('.rider-shortcuts__tabs')!;
    TABS.forEach((tab, index) => {
      const item = button(tab.label, () => {
        this.activeTab = tab.id;
        this.status('');
        this.renderPanel();
        this.focusTab();
      });
      item.id = `rider-shortcuts-tab-${tab.id}`;
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-controls', 'rider-shortcuts-panel');
      item.addEventListener('keydown', (event) => {
        const next =
          event.key === 'ArrowRight'
            ? (index + 1) % TABS.length
            : event.key === 'ArrowLeft'
              ? (index + TABS.length - 1) % TABS.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? TABS.length - 1
                  : null;
        if (next === null) return;
        event.preventDefault();
        this.activeTab = TABS[next].id;
        this.status('');
        this.renderPanel();
        this.focusTab();
      });
      tabs.append(item);
    });
    this.append(trigger, this.dialog);
  }

  private focusTab(): void {
    this.dialog
      ?.querySelector<HTMLElement>(`#rider-shortcuts-tab-${this.activeTab}`)
      ?.focus();
  }

  private isEditing(): boolean {
    return [
      ...(this.dialog?.querySelectorAll<HTMLInputElement>(
        '.rider-shortcuts__form input'
      ) ?? [])
    ].some(
      (input) => input === document.activeElement || input.value.length > 0
    );
  }
  private status(message: string): void {
    const element = this.dialog?.querySelector('.rider-shortcuts__status');
    if (element) element.textContent = message;
  }

  private renderPanel(): void {
    if (!this.dialog) return;
    for (const tab of TABS) {
      const element = this.dialog.querySelector<HTMLButtonElement>(
        `#rider-shortcuts-tab-${tab.id}`
      )!;
      element.setAttribute('aria-selected', String(tab.id === this.activeTab));
      element.tabIndex = tab.id === this.activeTab ? 0 : -1;
    }
    const panel = this.dialog.querySelector<HTMLElement>(
      '.rider-shortcuts__panel'
    )!;
    const scrollTop = panel.scrollTop;
    panel.replaceChildren();
    panel.setAttribute(
      'aria-labelledby',
      `rider-shortcuts-tab-${this.activeTab}`
    );
    const data = getRiderShortcuts();
    if (this.activeTab === 'stops') {
      this.summary(panel, `${data.stops.length} of 20 saved stops`);
      if (!data.stops.length)
        this.empty(
          panel,
          'Keep a stop close',
          'Open any stop on the map and tap Save stop.'
        );
      data.stops.forEach((stop) => {
        const row = this.row(
          stop.stopName,
          stop.routes.length ? stop.routes.join(' · ') : `Stop ${stop.stopId}`,
          () => this.select(() => this.context?.onSelectStop(stop))
        );
        const share = button(
          'Share',
          () => {
            void copyStopLink(stop.stopId, share, (message) =>
              this.status(message)
            );
          },
          'rider-shortcuts__secondary'
        );
        share.setAttribute('aria-label', `Share ${stop.stopName}`);
        row.append(
          share,
          this.removeButton('stop', stop.stopId, stop.stopName)
        );
        panel.append(row);
      });
    } else if (this.activeTab === 'places') {
      const origin = this.context?.getOrigin() ?? null;
      this.summary(panel, `${data.places.length} of 8 planning places`);
      const description = origin
        ? `Save planning location: ${origin.label || 'Selected location'}`
        : 'Choose a planning location on the map to save it here.';
      panel.append(
        this.nameForm(
          'Place name',
          'Save place',
          description,
          (name) =>
            origin
              ? savePlace(name, origin, origin.label)
              : { ok: false, message: 'Choose a planning location first.' },
          !origin
        )
      );
      if (!data.places.length)
        this.empty(
          panel,
          'Plan from familiar places',
          'Save a chosen location as Home, Work or Campus.'
        );
      data.places.forEach((place) => {
        const row = this.row(
          place.name,
          place.label || 'Saved planning location',
          () => this.select(() => this.context?.onSelectPlace(place))
        );
        row.append(
          this.rename('place', place.id, place.name, row),
          this.removeButton('place', place.id, place.name)
        );
        panel.append(row);
      });
    } else if (this.activeTab === 'recent') {
      this.summary(panel, `${data.recent.length} recent routes and stops`);
      if (data.recent.length)
        panel.append(
          button(
            'Clear recent',
            () => {
              clearRecentShortcuts();
              this.status('Recent history cleared.');
              this.focusTab();
            },
            'rider-shortcuts__text-action'
          )
        );
      else
        this.empty(
          panel,
          'Pick up where you left off',
          'Routes and stops you open will appear here.'
        );
      data.recent.forEach((recent) => {
        const label =
          recent.kind === 'route' ? recent.label : recent.stop.stopName;
        const row = this.row(
          label,
          recent.kind === 'route'
            ? `Route ${recent.routeId}`
            : `Stop · ${recent.stop.routes.join(' · ') || recent.stop.stopId}`,
          () =>
            this.select(() => {
              if (recent.kind === 'route')
                this.context?.onSelectRoute(recent.routeId);
              else this.context?.onSelectStop(recent.stop);
            })
        );
        row.append(this.removeButton('recent', recent.id, label));
        panel.append(row);
      });
    } else {
      this.summary(panel, `${data.views.length} of 8 saved views`);
      panel.append(
        this.nameForm(
          'View name',
          'Save current view',
          'Saves your route, transit systems and travel directions.',
          (name) =>
            this.context
              ? saveFilterView(name, this.context.getFilters())
              : { ok: false, message: 'The map is still getting ready.' },
          !this.context
        )
      );
      if (!data.views.length)
        this.empty(
          panel,
          'Switch commute views in one tap',
          'Save the map filters you use together.'
        );
      data.views.forEach((view) => {
        const row = this.row(view.name, this.describeView(view), () =>
          this.select(() => this.context?.onApplyFilters(view.filters))
        );
        row.append(
          this.rename('view', view.id, view.name, row),
          this.removeButton('view', view.id, view.name)
        );
        panel.append(row);
      });
    }
    panel.scrollTop = scrollTop;
  }

  private select(action: () => void): void {
    this.close();
    action();
  }

  private summary(panel: HTMLElement, text: string): void {
    const summary = document.createElement('p');
    summary.className = 'rider-shortcuts__summary';
    summary.textContent = text;
    panel.append(summary);
  }

  private empty(panel: HTMLElement, title: string, description: string): void {
    const empty = document.createElement('div');
    empty.className = 'rider-shortcuts__empty';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const text = document.createElement('p');
    text.textContent = description;
    empty.append(heading, text);
    panel.append(empty);
  }

  private row(label: string, detail: string, action: () => void): HTMLElement {
    const row = document.createElement('div');
    row.className = 'rider-shortcuts__row';
    const primary = button('', action, 'rider-shortcuts__primary');
    const title = document.createElement('strong');
    title.textContent = label;
    const description = document.createElement('span');
    description.textContent = detail;
    primary.append(title);
    if (detail && detail !== label) primary.append(description);
    row.append(primary);
    return row;
  }

  private removeButton(
    kind: 'stop' | 'place' | 'view' | 'recent',
    id: string,
    label: string
  ): HTMLButtonElement {
    const remove = button(
      'Remove',
      () => {
        removeShortcut(kind, id);
        // If a separate naming draft is open, keep its node and remove only this row.
        if (remove.isConnected)
          remove.closest('.rider-shortcuts__row')?.remove();
        this.status(`${label} removed.`);
        this.focusTab();
      },
      'rider-shortcuts__secondary'
    );
    remove.setAttribute('aria-label', `Remove ${label}`);
    return remove;
  }

  private rename(
    kind: 'place' | 'view',
    id: string,
    name: string,
    row: HTMLElement
  ): HTMLButtonElement {
    return button(
      'Rename',
      () => {
        if (row.querySelector('form')) return;
        const form = this.nameForm(
          `Rename ${name}`,
          'Save name',
          '',
          (value) => {
            return renameShortcut(kind, id, value);
          }
        );
        const input = form.querySelector('input')!;
        input.value = name;
        form.append(
          button(
            'Cancel',
            () => {
              form.remove();
              row.querySelector<HTMLElement>('button')?.focus();
            },
            'rider-shortcuts__secondary'
          )
        );
        row.append(form);
        input.focus();
        input.select();
      },
      'rider-shortcuts__secondary'
    );
  }

  private nameForm(
    label: string,
    action: string,
    description: string,
    save: (name: string) => ShortcutResult,
    disabled = false
  ): HTMLFormElement {
    const form = document.createElement('form');
    form.className = 'rider-shortcuts__form';
    const fieldLabel = document.createElement('label');
    fieldLabel.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.required = true;
    input.maxLength = 60;
    input.disabled = disabled;
    input.autocomplete = 'off';
    fieldLabel.append(input);
    form.append(fieldLabel);
    if (description) {
      const help = document.createElement('p');
      help.textContent = description;
      form.append(help);
    }
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'rider-shortcuts__save';
    submit.textContent = action;
    submit.disabled = disabled;
    form.append(submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (disabled) return;
      if (!input.value.trim()) {
        input.setCustomValidity('Enter a name.');
        input.reportValidity();
        return;
      }
      const result = save(input.value);
      if (result.ok) {
        this.renderPanel();
        this.focusTab();
      }
      this.status(result.message);
    });
    input.addEventListener('input', () => input.setCustomValidity(''));
    return form;
  }

  private describeView(view: SavedView): string {
    const filters = view.filters;
    const systems =
      [
        filters.selectedSystems.prt ? 'PRT' : '',
        filters.selectedSystems.cmu ? 'CMU' : ''
      ]
        .filter(Boolean)
        .join(' + ') || 'No systems';
    const directions =
      filters.selectedDirections.inbound && filters.selectedDirections.outbound
        ? 'Both directions'
        : filters.selectedDirections.inbound
          ? 'Inbound'
          : filters.selectedDirections.outbound
            ? 'Outbound'
            : 'No directions';
    return `${filters.selectedRouteId ? `Route ${filters.selectedRouteId}` : 'All routes'} · ${systems} · ${directions}`;
  }
}

if (!customElements.get('rider-shortcuts'))
  customElements.define('rider-shortcuts', RiderShortcuts);
