/**
 * Shared map-popup utilities — unified minimize / restore / dismiss lifecycle.
 *
 * Each popup type ('route' | 'stop' | 'bus') maintains its own cache slot so
 * multiple minimized tabs can coexist at the bottom of the map simultaneously.
 * Only one full popup is visible at a time; opening a new type auto-minimizes
 * the current one rather than dismissing it.
 */

import { escapeHtml } from './html';

export type PopupType = 'route' | 'stop' | 'bus';

/** The single id used for every map overlay popup. */
export const MAP_POPUP_ID = 'map-popup';

interface SlotState {
  html: string;
  scrollTop: number;
  onRestore: (() => void) | null;
  label: string;
  badgeText?: string;
  badgeColor?: string;
}

// Per-type cached state (used for tabs and restore)
const slotCache = new Map<PopupType, SlotState>();

// Which type's full popup is currently shown
let activeType: PopupType | null = null;

// Minimize params for the currently active popup (for auto-minimize)
let activeParams: Omit<SlotState, 'html' | 'scrollTop'> | null = null;

// ── Popup Shell ─────────────────────────────────────────────────────

/**
 * Create a bare popup shell with a header row.
 * Returns { popup, subheader } ready to be populated by the caller.
 *
 * @param iconModifier  BEM modifier for the icon span, e.g. 'stop' or 'bus'
 * @param iconName      Material icon name, e.g. 'place' or 'directions_bus'
 * @param titleText     Text for the bold title element
 * @param minimizeTitle Optional title attribute on the minimize button
 */
export function createMapPopup(
  iconModifier: string,
  iconName: string,
  titleText: string,
  minimizeTitle?: string
): { popup: HTMLDivElement; subheader: HTMLDivElement } {
  const popup = document.createElement('div');
  popup.id = MAP_POPUP_ID;
  popup.className = 'map-popup';

  const header = document.createElement('div');
  header.className = 'map-popup__header';
  const titleAttr = minimizeTitle ? ` title="${minimizeTitle}"` : '';
  header.innerHTML = `
    <span class="material-icons-outlined map-popup__icon map-popup__icon--${iconModifier}">${iconName}</span>
    <strong class="map-popup__title">${escapeHtml(titleText)}</strong>
    <button class="map-popup__minimize" aria-label="Minimize"${titleAttr}>&ndash;</button>
    <button class="map-popup__close" aria-label="Close">&times;</button>
  `;
  popup.appendChild(header);

  const subheader = document.createElement('div');
  subheader.className = 'map-popup__subheader';
  popup.appendChild(subheader);

  return { popup, subheader };
}

// ── Active Popup Registration ────────────────────────────────────────

/**
 * Register the currently-shown popup so the utility knows how to
 * auto-minimize it if a different popup type is opened.
 * Call this after showing the popup and binding its minimize button.
 */
export function registerActivePopup(
  type: PopupType,
  label: string,
  onRestore: () => void,
  badgeText?: string,
  badgeColor?: string
): void {
  activeType = type;
  activeParams = { label, onRestore, badgeText, badgeColor };
}

/**
 * Call at the start of each popup-show function instead of dismissPopup().
 * - Same type: dismisses existing popup/tab for that type (clean replacement).
 * - Different type: auto-minimizes the active popup to a tab, leaving it
 *   accessible while the new popup opens.
 */
export function prepareForNewPopup(incomingType: PopupType): void {
  if (!activeType) {
    // No popup active — just ensure no stale same-type tab exists
    removeTabForType(incomingType);
    slotCache.delete(incomingType);
    return;
  }

  if (activeType === incomingType) {
    // Replacing the same type: full dismiss of that slot
    closeMapPopup();
    removeTabForType(incomingType);
    slotCache.delete(incomingType);
    activeType = null;
    activeParams = null;
  } else {
    // Different type: auto-minimize current popup so its tab is preserved
    if (activeParams) {
      _minimizeActive(activeType, activeParams);
    } else {
      closeMapPopup();
    }
    activeType = null;
    activeParams = null;
  }
}

/** Internal: minimize the active popup to a tab without changing activeType/Params. */
function _minimizeActive(
  type: PopupType,
  params: Omit<SlotState, 'html' | 'scrollTop'>
): void {
  cachePopupState(type, params);

  closeMapPopup();
  _createTab(type, params.label, params.badgeText, params.badgeColor);
}

// ── Minimize → Docked Tab ───────────────────────────────────────────

/**
 * Minimize the current popup into a small docked tab at the bottom.
 *
 * @param type       Popup type owning this tab slot
 * @param label      Short text summarising the popup (e.g. stop name)
 * @param onRestore  Callback invoked when the user clicks the tab to restore
 * @param badgeText  Optional badge text (route id)
 * @param badgeColor Optional badge background colour (route colour)
 */
export function minimizePopup(
  type: PopupType,
  label: string,
  onRestore: () => void,
  badgeText?: string,
  badgeColor?: string
): void {
  cachePopupState(type, {
    onRestore,
    label,
    badgeText,
    badgeColor
  });

  closeMapPopup();
  removeTabForType(type);
  _createTab(type, label, badgeText, badgeColor);

  if (activeType === type) {
    activeType = null;
    activeParams = null;
  }
}

const TAB_ORDER: PopupType[] = ['route', 'stop', 'bus'];

function cachePopupState(
  type: PopupType,
  params: Omit<SlotState, 'html' | 'scrollTop'>
): void {
  const popup = document.getElementById(MAP_POPUP_ID);
  const scrollTop = popup?.querySelector('.map-popup__list')?.scrollTop ?? 0;
  const html = popup?.innerHTML ?? '';

  slotCache.set(type, {
    html,
    scrollTop,
    onRestore: params.onRestore,
    label: params.label,
    badgeText: params.badgeText,
    badgeColor: params.badgeColor
  });
}

function _createTab(
  type: PopupType,
  label: string,
  badgeText?: string,
  badgeColor?: string
): void {
  const container = getOrCreateTabContainer();
  if (!container) return;

  const tab = document.createElement('div');
  tab.className = 'map-popup-tab';
  tab.dataset.type = type;
  tab.setAttribute('role', 'button');
  tab.tabIndex = 0;
  tab.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      tab.click();
    }
  });

  let inner =
    '<span class="material-icons-outlined map-popup-tab__arrow">expand_less</span>';
  if (badgeText) {
    const style =
      badgeColor && /^#[\da-f]{6}$/i.test(badgeColor)
        ? ` style="background:${badgeColor}"`
        : '';
    inner += `<span class="map-popup-tab__badge"${style}>${escapeHtml(badgeText)}</span>`;
  }
  inner += `<span class="map-popup-tab__label">${escapeHtml(label)}</span>`;
  tab.innerHTML = inner;

  tab.addEventListener('click', () => {
    restorePopup(type);
  });

  // Insert in stable order (route → stop → bus) rather than appending
  const typeRank = TAB_ORDER.indexOf(type);
  const after = Array.from(container.children).find((el) => {
    const rank = TAB_ORDER.indexOf(
      (el as HTMLElement).dataset.type as PopupType
    );
    return rank > typeRank;
  });
  if (after) {
    container.insertBefore(tab, after);
  } else {
    container.appendChild(tab);
  }
}

// ── Restore from Tab ────────────────────────────────────────────────

/**
 * Restore a minimized popup from its docked tab.
 * If a different popup type is currently shown, it is auto-minimized first.
 */
export function restorePopup(type: PopupType): void {
  // Auto-minimize the currently active popup if it's a different type
  if (activeType && activeType !== type && activeParams) {
    _minimizeActive(activeType, activeParams);
    activeType = null;
    activeParams = null;
  } else if (activeType && activeType !== type) {
    closeMapPopup();
    activeType = null;
    activeParams = null;
  }

  removeTabForType(type);

  const cached = slotCache.get(type);
  if (!cached) return;

  const container = document.querySelector('.map-container');
  if (!container) return;

  const popup = document.createElement('div');
  popup.id = MAP_POPUP_ID;
  popup.className = 'map-popup';
  popup.innerHTML = cached.html;
  container.appendChild(popup);

  const scrollableList = popup.querySelector('.map-popup__list');
  if (scrollableList) {
    scrollableList.scrollTop = cached.scrollTop;
  }

  if (cached.onRestore) {
    cached.onRestore();
  }

  slotCache.delete(type);
  activeType = type;
  activeParams = {
    label: cached.label,
    onRestore: cached.onRestore ?? undefined,
    badgeText: cached.badgeText,
    badgeColor: cached.badgeColor
  } as Omit<SlotState, 'html' | 'scrollTop'>;
}

// ── Close / Dismiss ─────────────────────────────────────────────────

/**
 * Remove the currently-visible map popup, if any.
 */
export function closeMapPopup(): void {
  const existing = document.getElementById(MAP_POPUP_ID);
  if (existing) existing.remove();
}

/**
 * Fully dismiss a specific popup type (popup + tab + cached state).
 * Called with no argument to dismiss everything (navigation, route reset).
 */
export function dismissPopup(type?: PopupType): void {
  if (type) {
    if (activeType === type) {
      closeMapPopup();
      activeType = null;
      activeParams = null;
    }
    removeTabForType(type);
    slotCache.delete(type);
  } else {
    // Dismiss all
    closeMapPopup();
    removeAllTabs();
    slotCache.clear();
    activeType = null;
    activeParams = null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function removeTabForType(type: PopupType): void {
  const container = document.getElementById('map-popup-tabs');
  if (!container) return;
  const tab = container.querySelector<HTMLElement>(
    `.map-popup-tab[data-type="${type}"]`
  );
  if (tab) tab.remove();
  // Remove container if now empty
  if (!container.hasChildNodes()) container.remove();
}

function removeAllTabs(): void {
  const container = document.getElementById('map-popup-tabs');
  if (container) container.remove();
}

function getOrCreateTabContainer(): HTMLElement | null {
  const existing = document.getElementById('map-popup-tabs');
  if (existing) return existing;

  const mapContainer = document.querySelector('.map-container');
  if (!mapContainer) return null;

  const container = document.createElement('div');
  container.id = 'map-popup-tabs';
  mapContainer.appendChild(container);
  return container;
}

/**
 * Returns true if there is at least one minimised popup tab currently visible.
 */
export function hasMinimisedTab(): boolean {
  const container = document.getElementById('map-popup-tabs');
  return !!container && container.hasChildNodes();
}
