import type { ILatLng } from '../../../common/map.interface';
import { haversineMeters } from '../../../common/geo';
import { copyStopLink } from '../utils/stop-link';
import {
  clearRecentShortcuts,
  getRiderShortcuts,
  isStopSaved,
  toggleSavedStop,
  removeShortcutWithUndo,
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
import { getToken } from '../services/session';

type Tab = 'stops' | 'places' | 'recent' | 'views';
export type ShortcutOrigin = ILatLng & { label?: string };
export interface RiderShortcutsContext {
  getOrigin(): (ILatLng & { label?: string }) | null;
  getFilters(): ShortcutFilters;
  onSelectStop(stop: SavedStop): void;
  onSelectRoute(routeId: string): void;
  onSelectPlace(place: SavedPlace): void;
  onApplyFilters(filters: ShortcutFilters): void;
  onFindNearby?(origin?: ShortcutOrigin): void;
  onUseStopAsOrigin?(stop: SavedStop): void;
  onChoosePlace?(
    onChosen: (origin: ShortcutOrigin | null) => void
  ): (() => void) | void;
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
  private stopTools = document.createElement('div');
  private recentTools = document.createElement('div');
  private unsubscribe: (() => void) | null = null;
  private returnFocus: HTMLElement | null = null;
  private choiceVersion = 0;
  private cancelChoice?: () => void;

  connectedCallback(): void {
    if (!this.dialog) this.build();
    this.unsubscribe?.();
    this.unsubscribe = subscribeRiderShortcuts((accountChanged) => {
      if (accountChanged) {
        this.activeTab = 'stops';
        this.stopQuery.value = '';
        this.stopOrder.value = 'saved';
        this.recentKind.value = 'all';
        this.close();
        return;
      }
      // Background recents/storage updates must not replace a naming field mid-edit.
      if (this.dialog?.open && !this.isEditing()) this.renderPanel();
    });
  }

  disconnectedCallback(): void {
    this.choiceVersion++;
    this.cancelChoice?.();
    this.cancelChoice = undefined;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.dialog?.open) this.dialog.close();
  }

  configure(context: RiderShortcutsContext): void {
    this.context = context;
    if (this.dialog?.open) this.renderPanel();
  }

  open(tab: Tab = this.activeTab): void {
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
    this.choiceVersion++;
    this.cancelChoice?.();
    this.cancelChoice = undefined;
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
    this.stopTools.className = 'rider-shortcuts__filters';
    this.stopTools.innerHTML =
      '<input type="search" aria-label="Search saved stops" placeholder="Stop name, number or route" autocomplete="off"><select aria-label="Saved stop order"><option value="saved">Saved order</option><option value="nearest">Nearest first</option></select>';
    this.stopQuery.addEventListener('input', () => this.renderPanel());
    this.stopOrder.addEventListener('change', () => this.renderPanel());
    this.recentTools.className = 'rider-shortcuts__filters';
    this.recentTools.innerHTML =
      '<select aria-label="Recent item type"><option value="all">All recent items</option><option value="stop">Recent stops</option><option value="route">Recent routes</option></select>';
    this.recentKind.addEventListener('change', () => this.renderPanel());
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

  private get stopQuery(): HTMLInputElement {
    return this.stopTools.querySelector('input')!;
  }
  private get stopOrder(): HTMLSelectElement {
    return this.stopTools.querySelector('select')!;
  }
  private get recentKind(): HTMLSelectElement {
    return this.recentTools.querySelector('select')!;
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
    const openActions = new Set(
      [
        ...panel.querySelectorAll<HTMLElement>(
          '.rider-shortcuts__more[aria-expanded="true"]'
        )
      ].map((item) => item.getAttribute('aria-controls'))
    );
    panel.replaceChildren();
    panel.setAttribute(
      'aria-labelledby',
      `rider-shortcuts-tab-${this.activeTab}`
    );
    const data = getRiderShortcuts();
    // Keep the live search node mounted during input, including iOS composition.
    const activeTools =
      this.activeTab === 'stops' && data.stops.length
        ? this.stopTools
        : this.activeTab === 'recent' && data.recent.length
          ? this.recentTools
          : null;
    for (const tools of [this.stopTools, this.recentTools]) {
      if (tools === activeTools) {
        if (tools.nextElementSibling !== panel) panel.before(tools);
      } else tools.remove();
    }
    if (this.activeTab === 'stops') {
      const origin = this.context?.getOrigin();
      this.stopOrder.querySelector<HTMLOptionElement>(
        '[value="nearest"]'
      )!.disabled = !origin;
      if (!origin) this.stopOrder.value = 'saved';
      const query = this.stopQuery.value.trim().toLowerCase();
      const visible = data.stops.filter(
        (stop) =>
          !query ||
          [stop.stopId, stop.stopName, stop.nickname, ...stop.routes].some(
            (value) => value?.toLowerCase().includes(query)
          )
      );
      const distance = (stop: SavedStop) =>
        origin ? haversineMeters(origin, { lat: stop.lat, lng: stop.lon }) : 0;
      const nearest = this.stopOrder.value === 'nearest' && !!origin;
      if (nearest) visible.sort((a, b) => distance(a) - distance(b));
      this.summary(
        panel,
        query
          ? `${visible.length} matching saved stops`
          : `${data.stops.length} of 20 saved stops`
      );
      if (!data.stops.length) {
        this.empty(
          panel,
          'Keep a stop close',
          'Open any stop on the map and tap Save stop.'
        );
        if (this.context?.onFindNearby)
          panel.append(
            button(
              'Find nearby stops',
              () => this.select(() => this.context?.onFindNearby?.()),
              'rider-shortcuts__save rider-shortcuts__discover'
            )
          );
      }
      if (nearest)
        this.summary(
          panel,
          `Straight-line distance from ${origin.label || 'your planning location'}`
        );
      if (query && data.stops.length && !visible.length) {
        panel.append(
          button(
            'Clear stop search',
            () => {
              this.stopQuery.value = '';
              this.renderPanel();
              this.stopQuery.focus();
            },
            'rider-shortcuts__text-action'
          )
        );
      }
      visible.forEach(({ nickname, ...stop }) => {
        const label = nickname || stop.stopName;
        const service = [...stop.routes, `Stop ${stop.stopId}`];
        if (nearest) {
          const meters = distance(stop);
          service.push(
            meters < 1000
              ? `${Math.round(meters / 10) * 10} m`
              : `${(meters / 1000).toFixed(1)} km`
          );
        }
        const row = this.row(
          label,
          [nickname ? stop.stopName : '', ...service]
            .filter(Boolean)
            .join(' · '),
          () => this.select(() => this.context?.onSelectStop(stop))
        );
        const actions = document.createElement('div');
        actions.id = `rider-stop-actions-${stop.stopId}`;
        actions.className = 'rider-shortcuts__stop-actions';
        actions.hidden = !openActions.has(actions.id);
        const more = button(
          'More',
          () => {
            actions.hidden = !actions.hidden;
            more.setAttribute('aria-expanded', String(!actions.hidden));
            if (actions.hidden) actions.querySelector('form')?.remove();
          },
          'rider-shortcuts__more rider-shortcuts__secondary'
        );
        more.setAttribute('aria-controls', actions.id);
        more.setAttribute('aria-expanded', String(!actions.hidden));
        more.setAttribute('aria-label', `More actions for ${label}`);
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
        actions.append(
          ...(this.context?.onUseStopAsOrigin
            ? [
                button(
                  'Use as starting point',
                  () =>
                    this.select(() => this.context?.onUseStopAsOrigin?.(stop)),
                  'rider-shortcuts__secondary'
                )
              ]
            : []),
          this.rename('stop', stop.stopId, nickname || '', actions),
          share,
          this.removeButton('stop', stop.stopId, stop.stopName)
        );
        row.append(more, actions);
        panel.append(row);
      });
    } else if (this.activeTab === 'places') {
      let origin = this.context?.getOrigin() ?? null;
      this.summary(panel, `${data.places.length} of 8 planning places`);
      const description = origin
        ? `Save planning location: ${origin.label || 'Selected location'}`
        : 'Choose a planning location on the map to save it here.';
      const form = this.nameForm(
        'Place name',
        'Save place',
        description,
        (name) =>
          origin
            ? savePlace(name, origin, origin.label)
            : { ok: false, message: 'Choose a planning location first.' },
        !origin && !this.context?.onChoosePlace
      );
      panel.append(form);
      const nameInput = form.querySelector<HTMLInputElement>('input')!;
      const save = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      const updateReady = () => {
        save.disabled = !origin || !nameInput.value.trim();
      };
      nameInput.addEventListener('input', updateReady);
      updateReady();
      if (this.context?.onChoosePlace) {
        const choose = button(
          'Change location',
          () => {
            const version = ++this.choiceVersion;
            const token = getToken();
            this.dialog!.close();
            this.cancelChoice =
              this.context?.onChoosePlace?.((location) => {
                this.cancelChoice = undefined;
                if (
                  version !== this.choiceVersion ||
                  token !== getToken() ||
                  !this.isConnected
                )
                  return;
                if (location) {
                  origin = location;
                  let help = form.querySelector('p');
                  if (!help) {
                    help = document.createElement('p');
                    nameInput.closest('label')!.after(help);
                  }
                  help.textContent =
                    'Save planning location: ' +
                    (location.label || 'Selected location');
                }
                updateReady();
                // An Enter key that selects an autocomplete result must finish
                // before focus returns to this form, or it can also submit it.
                window.setTimeout(() => {
                  if (
                    version !== this.choiceVersion ||
                    token !== getToken() ||
                    !this.isConnected
                  )
                    return;
                  this.dialog!.showModal();
                  nameInput.focus({ preventScroll: true });
                }, 0);
              }) || undefined;
          },
          'rider-shortcuts__secondary rider-shortcuts__choose'
        );
        save.before(choose);
      }
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
        const actions = document.createElement('div');
        actions.className = 'rider-shortcuts__stop-actions';
        actions.id = `rider-place-actions-${place.id}`;
        actions.hidden = !openActions.has(actions.id);
        const more = button(
          'More',
          () => {
            actions.hidden = !actions.hidden;
            more.setAttribute('aria-expanded', String(!actions.hidden));
          },
          'rider-shortcuts__more rider-shortcuts__secondary'
        );
        more.setAttribute('aria-label', 'More actions for ' + place.name);
        more.setAttribute('aria-expanded', String(!actions.hidden));
        more.setAttribute('aria-controls', actions.id);
        if (this.context?.onFindNearby)
          actions.append(
            button(
              'Find nearby stops',
              () =>
                this.select(() =>
                  this.context?.onFindNearby?.({
                    lat: place.lat,
                    lng: place.lng,
                    label: place.name
                  })
                ),
              'rider-shortcuts__secondary'
            )
          );
        actions.append(
          this.rename('place', place.id, place.name, actions),
          this.removeButton('place', place.id, place.name)
        );
        row.append(more, actions);
        panel.append(row);
      });
    } else if (this.activeTab === 'recent') {
      const recentItems = data.recent.filter(
        (item) =>
          this.recentKind.value === 'all' || this.recentKind.value === item.kind
      );
      this.summary(
        panel,
        this.recentKind.value === 'all'
          ? `${data.recent.length} recent routes and stops`
          : `${recentItems.length} recent ${this.recentKind.value}s`
      );
      if (data.recent.length)
        panel.append(
          button(
            this.recentKind.value === 'all'
              ? 'Clear recent'
              : 'Clear all recent history',
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
      recentItems.forEach((recent) => {
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
        if (recent.kind === 'stop') {
          const saved = isStopSaved(recent.stop.stopId);
          const save = button(
            saved ? 'Saved' : 'Save stop',
            () => {
              if (isStopSaved(recent.stop.stopId)) return;
              this.status(toggleSavedStop(recent.stop).message);
              this.focusTab();
            },
            'rider-shortcuts__secondary'
          );
          save.disabled = saved;
          save.setAttribute(
            'aria-label',
            `${saved ? 'Already saved' : 'Save'} ${label}`
          );
          row.append(save);
        }
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
        const row = remove.closest('.rider-shortcuts__row');
        const parent = row?.parentElement;
        const next = row?.nextElementSibling;
        const removed = removeShortcutWithUndo(kind, id);
        // If a separate naming draft is open, keep its node and remove only this row.
        if (remove.isConnected)
          remove.closest('.rider-shortcuts__row')?.remove();
        this.status(`${label} removed.`);
        if (removed) {
          const undo = button(
            'Undo',
            () => {
              const result = removed.undo();
              // A different naming draft can keep this panel mounted while the
              // store changes. Restore the original row without replacing it.
              if (
                result.ok &&
                row &&
                !row.isConnected &&
                parent?.isConnected &&
                this.isEditing()
              )
                parent.insertBefore(
                  row,
                  next?.parentElement === parent ? next : null
                );
              this.status(result.message);
              this.focusTab();
            },
            'rider-shortcuts__undo'
          );
          this.dialog?.querySelector('.rider-shortcuts__status')?.append(undo);
        }
        this.focusTab();
      },
      'rider-shortcuts__secondary'
    );
    remove.setAttribute('aria-label', `Remove ${label}`);
    return remove;
  }

  private rename(
    kind: 'stop' | 'place' | 'view',
    id: string,
    name: string,
    row: HTMLElement
  ): HTMLButtonElement {
    const trigger = button(
      kind === 'stop' ? (name ? 'Edit nickname' : 'Add nickname') : 'Rename',
      () => {
        if (row.querySelector('form')) return;
        const form = this.nameForm(
          kind === 'stop' ? 'Stop nickname' : `Rename ${name}`,
          'Save name',
          kind === 'stop' ? 'Leave blank to use the official stop name.' : '',
          (value) => {
            return renameShortcut(kind, id, value);
          },
          false,
          kind === 'stop'
        );
        const input = form.querySelector('input')!;
        input.value = name;
        form.append(
          button(
            'Cancel',
            () => {
              form.remove();
              trigger.focus();
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
    return trigger;
  }

  private nameForm(
    label: string,
    action: string,
    description: string,
    save: (name: string) => ShortcutResult,
    disabled = false,
    allowEmpty = false
  ): HTMLFormElement {
    const form = document.createElement('form');
    form.className = 'rider-shortcuts__form';
    const fieldLabel = document.createElement('label');
    fieldLabel.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.required = !allowEmpty;
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
      if (!allowEmpty && !input.value.trim()) {
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
