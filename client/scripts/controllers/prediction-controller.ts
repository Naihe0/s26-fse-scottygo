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

/** Bundles the mutable state shared across stop-popup lifecycle methods. */
interface StopPopupContext {
  stop: IStop;
  /** Original full prediction list (used for minimize/restore). */
  predictions: IPrediction[];
  /** Indices of user-selected arrivals. */
  selectedIndices: Set<number>;
  /** Mutable display slice (up to 8, updated on each refresh). */
  displayPredictions: IPrediction[];
}
import { MapStateManager } from '../state/map-state';
import { RouteRenderer } from '../renderers/route-renderer';
import { VehicleTracker } from '../trackers/vehicle-tracker';
import { DirectionsController } from './directions-controller';
import { transitApiService } from '../services/transit-api.service';
import {
  MAP_POPUP_ID,
  createMapPopup,
  dismissPopup,
  minimizePopup,
  prepareForNewPopup,
  registerActivePopup
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

  /** Cached predictions for the minimised stop. */
  private minimisedPredictions: IPrediction[] = [];

  /** Stop ID of the currently open prediction popup (for live refresh). */
  private openPopupStopId: string | null = null;

  /** Route filter bound to the currently open stop popup, if any. */
  private openPopupRouteId: string | null = null;

  /** Interval handle for prediction auto-refresh (30 s). */
  private predictionPollInterval: number | null = null;

  /** Interval handle for 1-second countdown ticker. */
  private predictionTickerInterval: number | null = null;
  private requestVersion = 0;

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
    const version = ++this.requestVersion;
    if (this.restoreMinimisedPopup(stop)) return;

    try {
      const routeFilter =
        this.stateManager.getState().selectedRouteId ?? undefined;
      const predictions = await this.fetchPredictions(stop.stopId, routeFilter);
      if (version !== this.requestVersion || this.directionsController.isActive)
        return;
      this.showStopPopup(stop, predictions);
    } catch (error) {
      console.error('[PredictionController] Error handling stop click:', error);
    }
  }

  /**
   * Restore a minimised stop popup (A3).
   * Returns true when the stop matched the minimised stop and the popup was
   * restored — the caller should skip the normal click flow in that case.
   */
  restoreMinimisedPopup(stop: IStop): boolean {
    if (this.minimisedStop && this.minimisedStop.stopId === stop.stopId) {
      this.showStopPopup(stop, this.minimisedPredictions);
      this.minimisedStop = null;
      return true;
    }
    return false;
  }

  /** Stop prediction polling and the countdown ticker. */
  stopPolling(): void {
    this.requestVersion++;
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
    routeId?: string
  ): Promise<IPrediction[]> {
    return transitApiService.getPredictions(stopId, routeId);
  }

  private showStopPopup(stop: IStop, predictions: IPrediction[]): void {
    prepareForNewPopup('stop');
    this.stopPolling();
    this.minimisedStop = null;

    const ctx: StopPopupContext = {
      stop,
      predictions,
      selectedIndices: new Set<number>(),
      displayPredictions: predictions.slice(0, 8)
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
    this.buildPredictionListSection(ctx, directionsBtn).forEach((el) =>
      popup.appendChild(el)
    );
    popup.appendChild(directionsBtn);

    const container = document.querySelector('.map-container');
    if (container) container.appendChild(popup);

    this.bindMinimizeButton(popup, ctx);

    // Directions button handler (TUC4 Step 5)
    directionsBtn.addEventListener('click', async () => {
      const selectedPreds = ctx.displayPredictions.filter((_, idx) =>
        ctx.selectedIndices.has(idx)
      );
      const started = await this.directionsController.startDirections(
        stop,
        selectedPreds
      );
      if (started && selectedPreds.length > 0) {
        await this.renderSelectedBusRoutes(selectedPreds);
      }
    });

    this.startPredictionPolling(ctx);
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

  /**
   * Build the hint + list (or empty-state) nodes for the prediction popup.
   * Also wires click handlers on each arrival row.
   */
  private buildPredictionListSection(
    ctx: StopPopupContext,
    directionsBtn: HTMLButtonElement
  ): HTMLElement[] {
    const { displayPredictions, selectedIndices } = ctx;
    const nodes: HTMLElement[] = [];

    if (displayPredictions.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'map-popup__empty';
      empty.textContent = 'No upcoming arrivals';
      nodes.push(empty);
      return nodes;
    }

    const hint = document.createElement('p');
    hint.className = 'map-popup__select-hint';
    hint.textContent = 'Tap buses to include in directions';
    nodes.push(hint);

    const list = document.createElement('ul');
    list.className = 'map-popup__list';
    for (let i = 0; i < displayPredictions.length; i++) {
      list.appendChild(
        this.buildArrivalRow(
          displayPredictions[i],
          i,
          selectedIndices,
          directionsBtn
        )
      );
    }
    nodes.push(list);
    return nodes;
  }

  private buildArrivalRow(
    p: IPrediction,
    index: number,
    selectedIndices: Set<number>,
    directionsBtn: HTMLButtonElement
  ): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'map-popup__arrival map-popup__arrival--selectable';
    li.dataset.predIndex = String(index);
    li.dataset.arrival = String(p.predictedArrivalTime);
    li.setAttribute('role', 'button');
    li.tabIndex = 0;
    li.classList.toggle(
      'map-popup__arrival--selected',
      selectedIndices.has(index)
    );
    li.setAttribute('aria-pressed', String(selectedIndices.has(index)));
    li.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        li.click();
      }
    });

    const routeBadge = document.createElement('span');
    routeBadge.className = 'map-popup__route-badge';
    routeBadge.style.backgroundColor = this.getRouteColor(p.routeId);
    routeBadge.textContent = p.routeId;

    const mins = document.createElement('span');
    mins.className = 'map-popup__minutes';
    mins.textContent = this.formatCountdown(p.predictedArrivalTime);

    const meta = document.createElement('span');
    meta.className = 'map-popup__meta';
    const parts: string[] = [];
    if (p.vid) parts.push(p.vid === 'Scheduled' ? 'Scheduled' : `Bus ${p.vid}`);
    if (p.isDelayed) parts.push('Delayed');
    meta.textContent = parts.join(' · ');

    li.appendChild(routeBadge);
    li.appendChild(mins);
    li.appendChild(meta);

    li.addEventListener('click', () => {
      if (selectedIndices.has(index)) {
        selectedIndices.delete(index);
        li.classList.remove('map-popup__arrival--selected');
      } else {
        selectedIndices.add(index);
        li.classList.add('map-popup__arrival--selected');
      }
      li.setAttribute('aria-pressed', String(selectedIndices.has(index)));
      this.updateDirectionsBtnLabel(directionsBtn, selectedIndices.size);
    });

    return li;
  }

  private buildDirectionsButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'map-popup__directions-btn';
    btn.innerHTML = `
      <span class="material-icons-outlined">directions_walk</span>
      Directions
    `;
    return btn;
  }

  private updateDirectionsBtnLabel(
    btn: HTMLButtonElement,
    count: number
  ): void {
    const label =
      count > 0
        ? `Directions (${count} bus${count > 1 ? 'es' : ''})`
        : 'Directions';
    btn.innerHTML = `
      <span class="material-icons-outlined">directions_walk</span>
      ${label}
    `;
  }

  // -------------------------------------------------------------------------
  // Private — polling
  // -------------------------------------------------------------------------

  private startPredictionPolling(ctx: StopPopupContext): void {
    this.stopPolling();
    this.openPopupStopId = ctx.stop.stopId;
    this.openPopupRouteId = this.stateManager.getState().selectedRouteId;
    const version = this.requestVersion;

    // 1-second countdown ticker
    this.predictionTickerInterval = window.setInterval(() => {
      if (!document.getElementById(MAP_POPUP_ID)) {
        this.stopPolling();
        return;
      }
      this.tickPredictionCountdowns();
    }, 1000);

    // 30-second full refresh from server
    this.predictionPollInterval = window.setInterval(async () => {
      if (!document.getElementById(MAP_POPUP_ID)) {
        this.stopPolling();
        return;
      }
      try {
        const fresh = await this.fetchPredictions(
          ctx.stop.stopId,
          this.openPopupRouteId ?? undefined
        );
        if (version !== this.requestVersion) return;
        this.refreshPredictionList(fresh.slice(0, 8), ctx);
      } catch (error) {
        if (version === this.requestVersion)
          console.warn('Could not refresh stop predictions:', error);
      }
    }, 30_000);
  }

  private tickPredictionCountdowns(): void {
    const popup = document.getElementById(MAP_POPUP_ID);
    if (!popup) return;
    const items = popup.querySelectorAll<HTMLElement>('.map-popup__arrival');
    items.forEach((li) => {
      const arrival = Number(li.dataset.arrival);
      if (!arrival) return;
      const minsEl = li.querySelector('.map-popup__minutes');
      if (minsEl) minsEl.textContent = this.formatCountdown(arrival);
    });
  }

  private formatCountdown(arrivalTimestamp: number): string {
    const secsLeft = Math.round((arrivalTimestamp - Date.now()) / 1000);
    if (secsLeft <= 0) return 'NOW';
    if (secsLeft < 60) return `${secsLeft}s`;
    return `${Math.ceil(secsLeft / 60)} min`;
  }

  private refreshPredictionList(
    freshPreds: IPrediction[],
    ctx: StopPopupContext
  ): void {
    const { selectedIndices, displayPredictions } = ctx;
    const popup = document.getElementById(MAP_POPUP_ID);
    if (!popup) return;

    const directionsBtn = popup.querySelector<HTMLButtonElement>(
      '.map-popup__directions-btn'
    );
    if (!directionsBtn) return;
    // Preserve selection by vehicle identity, not by the previous row index.
    // Scheduled rows have no vehicle identity, so use their scheduled arrival.
    const key = (prediction: IPrediction): string =>
      JSON.stringify([
        prediction.stopId,
        prediction.routeId,
        prediction.vid && prediction.vid !== 'Scheduled'
          ? prediction.vid
          : prediction.predictedArrivalTime
      ]);
    const selected = new Set(
      displayPredictions
        .filter((_, index) => selectedIndices.has(index))
        .map(key)
    );
    selectedIndices.clear();
    freshPreds.forEach((prediction, index) => {
      if (selected.has(key(prediction))) selectedIndices.add(index);
    });
    displayPredictions.splice(0, displayPredictions.length, ...freshPreds);
    ctx.predictions = freshPreds;
    popup
      .querySelectorAll(
        '.map-popup__list, .map-popup__select-hint, .map-popup__empty'
      )
      .forEach((element) => element.remove());
    this.buildPredictionListSection(ctx, directionsBtn).forEach((element) =>
      popup.insertBefore(element, directionsBtn)
    );
    this.updateDirectionsBtnLabel(directionsBtn, selectedIndices.size);
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
      this.minimisedPredictions = ctx.predictions;
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
        dismissPopup('stop');
      });
    }
  }

  private rebindStopPopupEvents(ctx: StopPopupContext): void {
    const { stop, displayPredictions, selectedIndices } = ctx;
    const popup = document.getElementById(MAP_POPUP_ID);
    if (!popup) return;

    this.bindMinimizeButton(popup, ctx);

    const items = popup.querySelectorAll('.map-popup__arrival--selectable');
    const directionsBtn = popup.querySelector(
      '.map-popup__directions-btn'
    ) as HTMLButtonElement | null;
    items.forEach((li) => {
      const idx = parseInt((li as HTMLElement).dataset.predIndex ?? '-1', 10);
      if (idx < 0) return;
      li.addEventListener('click', () => {
        if (selectedIndices.has(idx)) {
          selectedIndices.delete(idx);
          li.classList.remove('map-popup__arrival--selected');
        } else {
          selectedIndices.add(idx);
          li.classList.add('map-popup__arrival--selected');
        }
        li.setAttribute('aria-pressed', String(selectedIndices.has(idx)));
        if (directionsBtn) {
          this.updateDirectionsBtnLabel(directionsBtn, selectedIndices.size);
        }
      });
      li.addEventListener('keydown', (event) => {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
          keyboardEvent.preventDefault();
          (li as HTMLElement).click();
        }
      });
    });

    if (directionsBtn) {
      directionsBtn.addEventListener('click', async () => {
        const selectedPreds = displayPredictions.filter((_, i) =>
          selectedIndices.has(i)
        );
        const started = await this.directionsController.startDirections(
          stop,
          selectedPreds
        );
        if (started && selectedPreds.length > 0) {
          await this.renderSelectedBusRoutes(selectedPreds);
        }
      });
    }

    this.startPredictionPolling(ctx);
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
        this.routeRenderer.renderRouteGeometry(routeId, geometry, color);
      }

      for (const direction of ['INBOUND', 'OUTBOUND']) {
        const stops = await transitApiService.getStops(routeId, direction);
        if (!isCurrent()) return;
        if (stops.length > 0) {
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

export const predictionController = PredictionController.getInstance();
