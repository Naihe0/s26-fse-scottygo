/**
 * Prediction Controller
 *
 * Owns the stop-prediction popup lifecycle:
 *   - fetching arrival predictions from the backend
 *   - building and mounting the stop popup DOM
 *   - 1-second countdown ticker
 *   - 30-second full-refresh polling
 *   - minimize / restore flow
 *   - "Directions" bus-selection UI
 *
 * Extracted from FilterController so that popup / prediction changes no
 * longer require edits to the main filter state machine.
 *
 * Dependencies on FilterController state (route colors, walk-time estimate)
 * are injected as callbacks via setRouteColorProvider / setWalkTimeProvider.
 */

import type { IStop, IPrediction } from '../../../common/transit.interface';

import { StopArrivalBoard } from '../components/stop-arrival-board';

interface StopPopupContext {
  stop: IStop;
  board: StopArrivalBoard;
  unavailable: boolean;
}
import { MapStateManager } from '../state/map-state';
import { RouteRenderer } from '../renderers/route-renderer';
import { VehicleTracker } from '../trackers/vehicle-tracker';
import { DirectionsController } from './directions-controller';
import { transitApiService } from '../services/transit-api.service';
import { copyStopLink } from '../utils/stop-link';
import {
  isStopSaved,
  recordRecentStop,
  subscribeRiderShortcuts,
  toggleSavedStop
} from '../utils/rider-shortcuts';
import { showToast } from '../utils/toast';
import {
  MAP_POPUP_ID,
  createMapPopup,
  dismissPopup,
  minimizePopup,
  prepareForNewPopup,
  registerActivePopup,
  restorePopup
} from '../utils/map-popup';

export class PredictionController {
  private static instance: PredictionController;

  private stateManager: MapStateManager;
  private routeRenderer: RouteRenderer;
  private vehicleTracker: VehicleTracker;
  private directionsController: DirectionsController;

  /** Provided by FilterController — returns the display color for a route ID. */
  private getRouteColor: (routeId: string) => string = () => '#4285F4';

  /** Provided by FilterController — returns walk minutes to a stop, or null. */
  private getWalkMinutes: (lat: number, lon: number) => number | null = () =>
    null;

  /** Currently minimised stop (for A3 restore). */
  private minimisedStop: IStop | null = null;

  /** Stop ID of the currently open prediction popup (for live refresh). */
  private openPopupStopId: string | null = null;

  /** Route filter bound to the currently open stop popup, if any. */
  private openPopupRouteId: string | null = null;

  /** Interval handle for prediction auto-refresh (30 s). */
  private predictionPollInterval: number | null = null;

  /** Interval handle for 1-second countdown ticker. */
  private predictionTickerInterval: number | null = null;
  private pollingEvents: AbortController | null = null;
  private requestVersion = 0;
  private stopSelectionPending = false;
  private stopShortcutUnsubscribe: (() => void) | null = null;
  private shortcutBindings = new WeakSet<Element>();
  private onSelection: (stop: IStop) => void = () => undefined;

  /** Avoid background map recovery while a stop is being selected or viewed. */
  get hasActiveSelection(): boolean {
    return this.stopSelectionPending || this.openPopupStopId !== null;
  }

  get sessionVersion(): number {
    return this.requestVersion;
  }

  private constructor() {
    this.stateManager = MapStateManager.getInstance();
    this.routeRenderer = RouteRenderer.getInstance();
    this.vehicleTracker = VehicleTracker.getInstance();
    this.directionsController = DirectionsController.getInstance();
  }

  static getInstance(): PredictionController {
    if (!PredictionController.instance) {
      PredictionController.instance = new PredictionController();
    }
    return PredictionController.instance;
  }

  /** Register a route color resolver (called once from FilterController). */
  setRouteColorProvider(fn: (routeId: string) => string): void {
    this.getRouteColor = fn;
  }

  /** Register a walk-time estimator (called once from FilterController). */
  setWalkTimeProvider(fn: (lat: number, lon: number) => number | null): void {
    this.getWalkMinutes = fn;
  }

  /** Notify map navigation when an explicit stop choice replaces earlier intent. */
  setSelectionCallback(callback: (stop: IStop) => void): void {
    this.onSelection = callback;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Handle a stop marker click: fetch predictions and show popup.
   * Supports A3 (restore minimised popup) and A1 (select another stop before
   * directions mode).
   */
  async handleStopClick(stop: IStop): Promise<void> {
    if (this.directionsController.isActive) return;
    if (this.restoreMinimisedPopup(stop)) return;
    this.onSelection(stop);
    this.routeRenderer.setSelectedStop?.(stop, (selected) => {
      void this.handleStopClick(selected);
    });
    const version = ++this.requestVersion;
    this.stopSelectionPending = true;

    try {
      const routeFilter =
        this.stateManager.getState().selectedRouteId ?? undefined;
      const predictions = await this.fetchPredictions(stop.stopId, routeFilter);
      if (version !== this.requestVersion || this.directionsController.isActive)
        return;
      this.showStopPopup(stop, predictions);
    } catch (error) {
      console.error('[PredictionController] Error handling stop click:', error);
    } finally {
      if (version === this.requestVersion) this.stopSelectionPending = false;
    }
  }

  /**
   * Restore a minimised stop popup (A3).
   * Returns true when the stop matched the minimised stop and the popup was
   * restored — the caller should skip the normal click flow in that case.
   */
  restoreMinimisedPopup(stop: IStop): boolean {
    if (
      this.minimisedStop?.stopId === stop.stopId &&
      document.querySelector('.map-popup-tab[data-type="stop"]')
    ) {
      restorePopup('stop');
      this.minimisedStop = null;
      return true;
    }
    return false;
  }

  /** Stop prediction polling and the countdown ticker. */
  stopPolling(): void {
    this.requestVersion++;
    this.stopSelectionPending = false;
    this.pollingEvents?.abort();
    this.pollingEvents = null;
    this.stopShortcutUnsubscribe?.();
    this.stopShortcutUnsubscribe = null;
    if (this.predictionPollInterval !== null) {
      clearInterval(this.predictionPollInterval);
      this.predictionPollInterval = null;
    }
    if (this.predictionTickerInterval !== null) {
      clearInterval(this.predictionTickerInterval);
      this.predictionTickerInterval = null;
    }
    this.openPopupStopId = null;
    this.openPopupRouteId = null;
  }

  // -------------------------------------------------------------------------
  // Private — popup building
  // -------------------------------------------------------------------------

  private async fetchPredictions(
    stopId: string,
    routeId?: string,
    signal?: AbortSignal
  ): Promise<IPrediction[] | null> {
    return transitApiService.getPredictionsResult(stopId, routeId, signal);
  }

  private showStopPopup(stop: IStop, predictions: IPrediction[] | null): void {
    prepareForNewPopup('stop');
    this.stopPolling();
    this.minimisedStop = null;

    const ctx: StopPopupContext = {
      stop,
      board: new StopArrivalBoard(
        predictions ?? [],
        predictions !== null,
        this.getRouteColor
      ),
      unavailable: predictions === null
    };

    const { popup, subheader } = createMapPopup(
      'stop',
      'place',
      stop.stopName,
      'Minimize'
    );

    const isUuidStopId =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        stop.stopId
      );
    subheader.textContent = isUuidStopId
      ? 'CMU Shuttle Stop'
      : `Stop #${stop.stopId}`;

    // Walking time estimate (TUC4 Step 4, R4: 1km ≈ 15 min)
    const walkMin = this.getWalkMinutes(stop.lat, stop.lon);
    if (walkMin !== null) {
      popup.appendChild(this.buildWalkTimeRow(walkMin));
    }

    const directionsBtn = this.buildDirectionsButton();
    const notice = document.createElement('div');
    notice.className = 'arrival-recovery';
    notice.innerHTML =
      '<span role="status"></span><button type="button">Retry arrivals</button>';
    popup.appendChild(notice);
    const boardHost = document.createElement('section');
    boardHost.className = 'stop-arrival-board';
    popup.appendChild(boardHost);
    popup.appendChild(directionsBtn);
    popup.appendChild(this.buildStopShortcutActions());

    const container = document.querySelector('.map-container');
    if (container) {
      container.appendChild(popup);
      recordRecentStop(stop);
    }

    this.bindStopCard(popup, ctx);
  }

  private bindStopCard(popup: HTMLElement, ctx: StopPopupContext): void {
    const directions = popup.querySelector<HTMLButtonElement>(
      '.map-popup__directions-btn'
    )!;
    ctx.board.mount(
      popup.querySelector<HTMLElement>('.stop-arrival-board')!,
      directions
    );
    this.bindMinimizeButton(popup, ctx);
    directions.addEventListener('click', async () => {
      const selected = ctx.board.selectedPredictions;
      const started = await this.directionsController.startDirections(
        ctx.stop,
        selected
      );
      if (started && selected.length)
        await this.renderSelectedBusRoutes(selected);
    });
    this.startPredictionPolling(ctx);
    this.bindStopShortcutActions(popup, ctx.stop);
  }

  private buildStopShortcutActions(): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'map-popup__actions map-popup__shortcut-actions';
    actions.innerHTML =
      '<button type="button" class="map-popup__action-btn map-popup__save-stop"><span class="material-icons-outlined" aria-hidden="true">bookmark_border</span><span>Save stop</span></button><button type="button" class="map-popup__action-btn map-popup__share-stop"><span class="material-icons-outlined" aria-hidden="true">share</span><span>Share stop</span></button>';
    return actions;
  }

  private bindStopShortcutActions(popup: Element, stop: IStop): void {
    const save = popup.querySelector<HTMLButtonElement>(
      '.map-popup__save-stop'
    );
    const share = popup.querySelector<HTMLButtonElement>(
      '.map-popup__share-stop'
    );
    if (!save || !share) return;
    // A cached popup may have been minimized during a pending clipboard write.
    share.disabled = false;
    const isCurrent = () =>
      popup.isConnected && document.getElementById(MAP_POPUP_ID) === popup;
    const refresh = () => {
      if (!isCurrent()) return;
      const saved = isStopSaved(stop.stopId);
      save.setAttribute('aria-pressed', String(saved));
      save.querySelector('.material-icons-outlined')!.textContent = saved
        ? 'bookmark'
        : 'bookmark_border';
      save.querySelector('span:last-child')!.textContent = saved
        ? 'Saved'
        : 'Save stop';
      save.setAttribute(
        'aria-label',
        saved
          ? `Remove saved stop ${stop.stopName}`
          : `Save stop ${stop.stopName}`
      );
    };
    // Restored popup HTML has no listeners; avoid rebinding a live node twice.
    if (!this.shortcutBindings.has(popup)) {
      this.shortcutBindings.add(popup);
      save.addEventListener('click', () => {
        if (!isCurrent()) return;
        const result = toggleSavedStop(stop);
        refresh();
        showToast(result.message);
      });
      share.addEventListener('click', () => {
        if (isCurrent()) void copyStopLink(stop.stopId, share, showToast);
      });
    }
    this.stopShortcutUnsubscribe?.();
    this.stopShortcutUnsubscribe = subscribeRiderShortcuts(refresh);
    refresh();
  }

  private buildWalkTimeRow(walkMin: number): HTMLElement {
    const walkRow = document.createElement('div');
    walkRow.className = 'map-popup__walk-time';
    walkRow.innerHTML = `
      <span class="material-icons-outlined map-popup__walk-icon">directions_walk</span>
      <span>~${walkMin} min walk</span>
    `;
    return walkRow;
  }

  private buildDirectionsButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'map-popup__directions-btn';
    btn.innerHTML = `
      <span class="material-icons-outlined" aria-hidden="true">directions_walk</span>
      <span data-directions-label>Directions</span>
    `;
    return btn;
  }

  // -------------------------------------------------------------------------
  // Private — polling
  // -------------------------------------------------------------------------

  private startPredictionPolling(ctx: StopPopupContext): void {
    this.stopPolling();
    const popup = document.getElementById(MAP_POPUP_ID);
    if (!popup) return;
    this.openPopupStopId = ctx.stop.stopId;
    this.openPopupRouteId = this.stateManager.getState().selectedRouteId;
    const version = this.requestVersion;
    const events = new AbortController();
    this.pollingEvents = events;
    const notice = popup.querySelector<HTMLElement>('.arrival-recovery')!;
    const retry = notice.querySelector('button')!;
    const refreshButton =
      popup.querySelector<HTMLButtonElement>('[data-refresh]')!;
    let fetching = false;
    const updateNotice = () => {
      notice.hidden = !ctx.unavailable;
      const label = ctx.board.hasPredictions
        ? 'Updates paused. Showing last known arrival times.'
        : 'Arrival times are unavailable.';
      const status = notice.querySelector('span')!;
      if (status.textContent !== label) status.textContent = label;
      refreshButton.hidden = ctx.unavailable;
      ctx.board.setUnavailable(ctx.unavailable);
    };
    updateNotice();

    // 1-second countdown ticker
    this.predictionTickerInterval = window.setInterval(() => {
      if (!popup.isConnected) {
        this.stopPolling();
        return;
      }
      if (!document.hidden && !ctx.unavailable) ctx.board.tick();
    }, 1000);

    // 30-second full refresh from server
    const refresh = async () => {
      if (!popup.isConnected) {
        this.stopPolling();
        return;
      }
      if (version !== this.requestVersion || fetching || document.hidden)
        return;
      if (navigator.onLine === false) {
        ctx.unavailable = true;
        updateNotice();
        return;
      }
      fetching = true;
      // aria-disabled retains keyboard focus while the pending request is
      // coalesced above. A disabled native button would drop focus to the page.
      retry.setAttribute('aria-disabled', 'true');
      refreshButton.setAttribute('aria-disabled', 'true');
      try {
        const fresh = await this.fetchPredictions(
          ctx.stop.stopId,
          this.openPopupRouteId ?? undefined,
          events.signal
        );
        if (version !== this.requestVersion || !popup.isConnected) return;
        const retryFocused = document.activeElement === retry;
        ctx.unavailable = fresh === null || !navigator.onLine;
        if (!ctx.unavailable && fresh) ctx.board.refresh(fresh);
        updateNotice();
        if (retryFocused && !ctx.unavailable)
          popup
            .querySelector<HTMLElement>(
              '.map-popup__arrival, .map-popup__directions-btn'
            )
            ?.focus();
      } finally {
        fetching = false;
        retry.removeAttribute('aria-disabled');
        refreshButton.removeAttribute('aria-disabled');
      }
    };
    retry.disabled = false;
    retry.removeAttribute('aria-disabled');
    refreshButton.addEventListener('click', refresh, { signal: events.signal });
    retry.addEventListener('click', refresh, { signal: events.signal });
    window.addEventListener('online', refresh, { signal: events.signal });
    window.addEventListener(
      'offline',
      () => {
        ctx.unavailable = true;
        updateNotice();
      },
      { signal: events.signal }
    );
    document.addEventListener('visibilitychange', refresh, {
      signal: events.signal
    });
    this.predictionPollInterval = window.setInterval(refresh, 30_000);
  }

  private bindMinimizeButton(popup: Element, ctx: StopPopupContext): void {
    const minBtn = popup.querySelector('.map-popup__minimize');
    if (!minBtn) return;
    const routeColor = this.getRouteColor(
      this.stateManager.getState().selectedRouteId ?? ''
    );
    const onRestore = () => this.rebindStopPopupEvents(ctx);
    minBtn.addEventListener('click', () => {
      this.minimisedStop = ctx.stop;
      this.stopPolling();
      minimizePopup(
        'stop',
        ctx.stop.stopName,
        onRestore,
        undefined,
        routeColor
      );
    });
    registerActivePopup(
      'stop',
      ctx.stop.stopName,
      onRestore,
      undefined,
      routeColor
    );

    const closeBtn = popup.querySelector('.map-popup__close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.stopPolling();
        this.routeRenderer.setSelectedStop?.(null);
        dismissPopup('stop');
      });
    }
  }

  private rebindStopPopupEvents(ctx: StopPopupContext): void {
    const { stop } = ctx;
    const popup = document.getElementById(MAP_POPUP_ID);
    if (!popup) return;
    this.minimisedStop = null;
    this.onSelection(stop);
    this.routeRenderer.setSelectedStop?.(stop, (selected) => {
      void this.handleStopClick(selected);
    });

    this.bindStopCard(popup, ctx);
  }

  // -------------------------------------------------------------------------
  // Private — directions bus-route rendering
  // -------------------------------------------------------------------------

  private async renderSelectedBusRoutes(
    predictions: IPrediction[]
  ): Promise<void> {
    const target = this.directionsController.targetStop;
    const isCurrent = () =>
      this.directionsController.isActive &&
      this.directionsController.targetStop === target &&
      this.directionsController.selectedPredictions === predictions;
    if (!isCurrent()) return;
    const routeIds = [...new Set(predictions.map((p) => p.routeId))];
    const state = this.stateManager.getState();

    for (const routeId of routeIds) {
      const geometry = await transitApiService.getPatterns(routeId);
      if (!isCurrent()) return;
      if (geometry) {
        const route = state.availableRoutes.find((r) => r.id === routeId);
        const color = route?.color || this.getRouteColor(routeId);
        this.routeRenderer.renderRouteGeometry(routeId, geometry, color, route?.name);
      }

      for (const direction of ['INBOUND', 'OUTBOUND']) {
        const stops = await transitApiService.getStops(routeId, direction);
        if (!isCurrent()) return;
        if (stops && stops.length > 0) {
          this.routeRenderer.renderStopMarkers(
            routeId,
            stops,
            direction,
            () => {} // No-op click handler while in directions mode
          );
        }
      }
    }

    const routeColors = new Map<string, string>();
    for (const routeId of routeIds) {
      routeColors.set(routeId, this.getRouteColor(routeId));
    }
    this.vehicleTracker.startMultiRoutePolling(routeIds, routeColors);
  }
}
