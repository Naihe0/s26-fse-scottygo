import axios from 'axios';
import { authService } from './services/auth.service';
import type { IMapProvider, IConfig } from '../../common/map.interface';
import type { IStop, IPrediction } from '../../common/transit.interface';
import { GoogleMapProvider } from './maps/google-map.provider';

// Import web components
import './components/app-header';
import './components/transit-search';
import './components/map-controls';
import './components/zoom-controls';
import './components/route-bell';
import './components/live-notifications';
import './components/bus-report-form';
import type { BusReportFormElement } from './components/bus-report-form';
import { showToast } from './utils/toast';
import type { IRouteBellElement } from './components/route-bell';
import { LocationIndicator } from './components/location-indicator';
import './components/location-search';
import type { ILocationSearchElement } from './components/location-search';
import './components/toggle-panel';
import './components/route-selector';
import './components/onboarding-tutorial';
import type { IOnboardingTutorialElement } from './components/onboarding-tutorial';
import type {
  ITogglePanelConfig,
  ITogglePanelElement
} from './components/toggle-panel';
import type {
  IRouteSelectorElement,
  IRouteSelection
} from './components/route-selector';

// Import state management and controllers
import { MapStateManager } from './state/map-state';
import { URLSyncManager } from './state/url-sync';
import { FilterController } from './controllers/filter-controller';
import { DirectionsController } from './controllers/directions-controller';
import { RouteRenderer } from './renderers/route-renderer';
import { VehicleTracker } from './trackers/vehicle-tracker';
import { getRouteTitle } from './utils/route-display';

// Export empty object to treat as module
export {};

// Modal utility functions

// Extend the global Window interface to include showModal
declare global {
  interface Window {
    showModal?: (title: string, message: string) => void;
  }
}

function showModal(title: string, message: string): void {
  const modal = document.getElementById('message-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalMessage = document.getElementById('modal-message');
  const okButton = document.getElementById('modal-ok');

  if (modal && modalTitle && modalMessage && okButton) {
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modal.classList.add('is-open');
    modal.removeAttribute('inert');

    // Close modal on OK button click
    const closeModal = () => {
      modal.classList.remove('is-open');
      modal.setAttribute('inert', '');
      okButton.removeEventListener('click', closeModal);
    };

    okButton.addEventListener('click', closeModal);
  } else {
    console.error('Modal elements not found in DOM:', {
      modal: !!modal,
      modalTitle: !!modalTitle,
      modalMessage: !!modalMessage,
      okButton: !!okButton
    });
    // Fallback to alert if modal not available
    alert(`${title}\n\n${message}`);
  }
}

// Export modal function for use in other modules
window.showModal = showModal;
console.log('showModal function registered globally');

// Global instances
const mapStateManager = MapStateManager.getInstance();
const urlSyncManager = URLSyncManager.getInstance();
const filterController = FilterController.getInstance();
const directionsController = DirectionsController.getInstance();
const routeRenderer = RouteRenderer.getInstance();
const vehicleTracker = VehicleTracker.getInstance();

function showSubscriptionToast(message: string): void {
  showToast(message);
}

// ─── Map provider ──────────────────────────────────────────────────────────────

// Map provider instance — depends on IMapProvider, not Google Maps directly
const mapProvider: IMapProvider = new GoogleMapProvider();

// Store user/initial location for recenter functionality
let userLocation: { lat: number; lng: number } | null = null;

/** CMU Pittsburgh campus center — fallback when GPS is denied */
const CMU_CAMPUS_DEFAULT = { lat: 40.4433, lng: -79.9436 };

/**
 * Get the best available location for map operations.
 * Priority: planned location → GPS location → CMU campus default.
 */
function getEffectiveLocation(): { lat: number; lng: number } {
  const state = mapStateManager.getState();
  return state.plannedLocation ?? userLocation ?? CMU_CAMPUS_DEFAULT;
}

// Store user location marker reference
import type { IMapMarker } from '../../common/map.interface';
let userLocationMarker: IMapMarker | null = null;

// Planned location marker (distinct from GPS blue dot)
let plannedLocationMarker: IMapMarker | null = null;

// Fetch map config (API key, default center, zoom) from server
async function getMapConfig(): Promise<IConfig | null> {
  try {
    const token = localStorage.getItem('token');
    const res: AxiosResponse = await axios.get('/config', {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });
    const response: IResponse = res.data;
    if (res.status === 200 && response.name === 'ConfigFound') {
      return response.payload as IConfig;
    }
    console.error('Failed to fetch map config:', response);
    return null;
  } catch (error) {
    console.error('Error fetching map config:', error);
    return null;
  }
}

// Document-ready event handler
document.addEventListener('DOMContentLoaded', async function (e: Event) {
  e.preventDefault();
  const loggedIn: boolean = await authService.isLoggedIn(); // Check if user logged in
  if (!loggedIn) {
    window.location.replace('/auth'); // Redirect to auth page
    return;
  }

  const username = localStorage.getItem('username');
  const userAccount = username
    ? await authService.getCurrentUserAccount(username)
    : null;
  const isAdminUser = userAccount?.privilegeLevel === 'Administrator';

  // Initialize map via provider abstraction
  const config = await getMapConfig();
  if (config) {
    const container = document.getElementById('map') as HTMLElement;

    try {
      await mapProvider.initialize(container, config);
    } catch (error) {
      console.error('Failed to initialize Google Maps:', error);
      showModal(
        'Map Unavailable',
        'Unable to load Google Maps. Please check your internet connection and try again.'
      );
      return;
    }

    // Initialize all components
    routeRenderer.initialize(mapProvider);

    // Track last pointer position for route-pick popup placement
    const mapContainer = document.querySelector(
      '.map-container'
    ) as HTMLElement;
    let lastPointerX = 0;
    let lastPointerY = 0;
    if (mapContainer) {
      mapContainer.addEventListener('mousemove', (e) => {
        const rect = mapContainer.getBoundingClientRect();
        lastPointerX = e.clientX - rect.left;
        lastPointerY = e.clientY - rect.top;
      });
      mapContainer.addEventListener(
        'touchstart',
        (e) => {
          const rect = mapContainer.getBoundingClientRect();
          lastPointerX = e.touches[0].clientX - rect.left;
          lastPointerY = e.touches[0].clientY - rect.top;
        },
        { passive: true }
      );
    }

    // Route polyline click handler — show route-pick popup
    routeRenderer.setRouteClickCallback((routeIds, _position) => {
      if (directionsController.isActive) return;
      showRoutePickPopup(routeIds, lastPointerX, lastPointerY);
    });

    vehicleTracker.initialize(mapProvider);
    vehicleTracker.setAdminProximityBypass(isAdminUser);
    directionsController.initialize(mapProvider);

    // Set up directions controller callbacks
    directionsController.setToastCallback(showToast);
    directionsController.setInfoPanelCallback(updateDirectionsPanel);
    directionsController.setLoadingCallback((loading) => {
      if (loading) {
        updateDirectionsPanel({
          durationMin: 0,
          eta: '',
          predictions: [],
          loading: true
        });
      } else if (
        document.getElementById('directions-panel')?.dataset.loading === 'true'
      ) {
        removeDirectionsPanel();
      }
    });
    directionsController.setExitCallback(async () => {
      // A4: Exit directions mode → restore previous map state
      const session = directionsController.sessionVersion;
      const isCurrent = () =>
        directionsController.sessionVersion === session &&
        !directionsController.isActive;
      enableFilterControls();
      removeDirectionsPanel();

      // If a route was selected before directions, re-apply that filter
      const prevRoute = mapStateManager.getState().selectedRouteId;
      if (prevRoute) {
        await filterController.applyRouteFilter(prevRoute, isCurrent);
      } else {
        await filterController.restoreDefaultState(getEffectiveLocation(), isCurrent);
      }
    });

    // Initialize toggle panels
    await initializeTogglePanels();

    // Initialize URL sync and restore state from URL
    urlSyncManager.initialize();

    // Set up route selector update callback before initializing filter controller
    filterController.setRouteSelectorCallback((routes) => {
      const routeSelector = document.querySelector(
        'route-selector-panel'
      ) as IRouteSelectorElement;
      if (routeSelector && 'setRoutes' in routeSelector) {
        routeSelector.setRoutes(routes);
        console.log(`Updated route selector with ${routes.length} routes`);
      }
    });

    // Initialize filter controller (fetches and renders routes)
    await filterController.initialize();

    // Sync subscription state from server so bell icons are accurate
    await authService.syncSubscriptionsFromServer();

    // Setup event listeners for filter panels
    setupMapEventListeners();

    // Show/hide the route bell whenever the selected route changes
    mapStateManager.subscribe((state) => {
      const bell = document.querySelector(
        'route-bell'
      ) as IRouteBellElement | null;
      if (!bell || typeof bell.showBell !== 'function') return;
      if (state.selectedRouteId) {
        bell.showBell(
          state.selectedRouteId,
          authService.isRouteSubscribed(state.selectedRouteId)
        );
      } else {
        bell.hideBell();
      }
    });

    // After initialization, if a route was restored from URL, apply route filter
    // to render stops/polylines and show the route info popup (same as a fresh
    // route selection — keeps the popup tab visible after a page refresh).
    const restoredState = mapStateManager.getState();
    if (restoredState.selectedRouteId) {
      console.log('Restoring route from URL:', restoredState.selectedRouteId);
      await filterController.applyRouteFilter(restoredState.selectedRouteId);
      await filterController.showRouteInfoPopup(restoredState.selectedRouteId);
    }

    // Request user location for centering map
    requestUserLocation();

    // Restore persisted planned location marker (if user set one previously)
    restorePlannedLocationMarker();

    // Start onboarding tutorial for first-time users (account-based)
    const tutorial = document.querySelector(
      'onboarding-tutorial'
    ) as IOnboardingTutorialElement | null;
    if (tutorial && userAccount && !userAccount.onboardingComplete) {
      // Mark onboarding complete on server when tutorial finishes
      tutorial.addEventListener('tutorial-complete', async () => {
        const token = localStorage.getItem('token');
        if (token) {
          await axios.patch(
            '/account/onboarding',
            {},
            {
              headers: { Authorization: `Bearer ${token}` },
              validateStatus: () => true
            }
          );
        }
      });

      // Wait for the map to fully render before starting the tutorial
      const provider =
        mapProvider as import('./maps/google-map.provider').GoogleMapProvider;
      if (typeof provider.getNativeMap === 'function') {
        const nativeMap = provider.getNativeMap();
        google.maps.event.addListenerOnce(nativeMap, 'tilesloaded', () => {
          tutorial.start();
        });
      }
    }
  } else {
    console.error('Map could not be initialized: config unavailable');
    showModal(
      'Map Configuration Error',
      'Map configuration is unavailable. Please check your internet connection and try again.'
    );
  }

  console.log('Map page loaded');
});

// Initialize toggle panels with their configurations
async function initializeTogglePanels(): Promise<void> {
  // Wait for the custom element to be defined
  await customElements.whenDefined('toggle-panel');

  // Direction Filter Panel Configuration
  const directionPanel = document.getElementById('direction-panel');
  console.log('Direction panel element:', directionPanel);

  if (directionPanel && 'configure' in directionPanel) {
    const directionConfig: ITogglePanelConfig = {
      options: [
        { id: 'inbound', label: 'Show Inbound', defaultChecked: true },
        { id: 'outbound', label: 'Show Outbound', defaultChecked: true }
      ],
      eventName: 'directionFilterApplied'
    };
    (directionPanel as ITogglePanelElement).configure(directionConfig);
  }

  // System Filter Panel Configuration (Rule R2: PRT ON, CMU OFF by default)
  const systemPanel = document.getElementById('system-panel');
  console.log('System panel element:', systemPanel);

  if (systemPanel && 'configure' in systemPanel) {
    const systemConfig: ITogglePanelConfig = {
      options: [
        {
          id: 'prt',
          label: 'Pittsburgh Regional Transit Routes',
          defaultChecked: true
        },
        { id: 'cmu', label: 'CMU Shuttle Routes', defaultChecked: false }
      ],
      eventName: 'systemFilterApplied'
    };
    (systemPanel as ITogglePanelElement).configure(systemConfig);
  }

  console.log('Toggle panels initialized');
}

// Helper function to get panel references
function getPanels(): {
  direction: HTMLElement | null;
  system: HTMLElement | null;
  route: HTMLElement | null;
} {
  return {
    direction: document.getElementById('direction-panel'),
    system: document.getElementById('system-panel'),
    route: document.querySelector('route-selector-panel')
  };
}

// Helper function to close all panels
function closeAllPanels(): void {
  const panels = getPanels();
  hidePanelIfOpen(panels.direction);
  hidePanelIfOpen(panels.system);
  hidePanelIfOpen(panels.route);
}

type PanelCollection = ReturnType<typeof getPanels>;
type PanelName = keyof PanelCollection;
type ToggleablePanel = {
  isOpen: () => boolean;
  hide: () => void;
  toggle: () => void;
};

const panelOrder: PanelName[] = ['direction', 'system', 'route'];

const isToggleablePanel = (panel: unknown): panel is ToggleablePanel =>
  !!panel &&
  typeof panel === 'object' &&
  'isOpen' in panel &&
  'hide' in panel &&
  'toggle' in panel &&
  typeof (panel as ToggleablePanel).isOpen === 'function' &&
  typeof (panel as ToggleablePanel).hide === 'function' &&
  typeof (panel as ToggleablePanel).toggle === 'function';

const hidePanelIfOpen = (panel: unknown): void => {
  if (isToggleablePanel(panel) && panel.isOpen()) {
    panel.hide();
  }
};

const togglePanelIfSupported = (panel: unknown): void => {
  if (isToggleablePanel(panel)) {
    panel.toggle();
  }
};

const closePanelsExcept = (
  panels: PanelCollection,
  keepPanel: PanelName
): void => {
  panelOrder.forEach((panelName) => {
    if (panelName !== keepPanel) {
      hidePanelIfOpen(panels[panelName]);
    }
  });
};

const handlePanelToggle = (
  panelName: PanelName,
  clickMessage: string,
  panelFoundMessage?: string
): void => {
  // Block filter interactions while in directions mode
  if (directionsController.isActive) return;
  console.log(clickMessage);
  const panels = getPanels();
  if (panelFoundMessage) {
    console.log(panelFoundMessage, panels[panelName]);
  }
  closePanelsExcept(panels, panelName);
  togglePanelIfSupported(panels[panelName]);
};

const registerTransitSearchEvents = (): void => {
  document.addEventListener('search', (e: Event) => {
    const customEvent = e as CustomEvent<{ query?: string }>;
    const query = customEvent.detail?.query?.trim() ?? '';
    console.log('Search query:', query);

    if (!query) {
      // Clear route-filter visual selection and restore default nearby-stops view.
      const routeSelector = document.querySelector(
        'route-selector-panel'
      ) as IRouteSelectorElement | null;
      routeSelector?.clearSelection();
      void filterController.restoreDefaultState(getEffectiveLocation());
    }
  });

  document.addEventListener('searchSelectRoute', (e: Event) => {
    const { routeId } = (e as CustomEvent).detail;
    mapStateManager.updateFilter('selectedRouteId', routeId);
    void filterController.applyRouteFilter(routeId);
  });

  document.addEventListener('searchSelectStop', (e: Event) => {
    const { stop } = (e as CustomEvent).detail as { stop: IStop | undefined };
    if (!stop) return;
    mapProvider.setCenter({ lat: stop.lat, lng: stop.lon });
    void filterController.showStopDetailsFromSearch(stop);
  });

  document.addEventListener('toggleLayers', () => {
    const mode = mapProvider.toggleLayers();
    showSubscriptionToast(`Map layer: ${mode}`);
  });
};

const registerFilterPanelToggleEvents = (): void => {
  document.addEventListener('filterRoute', () => {
    handlePanelToggle(
      'route',
      'Route filter clicked',
      'Route selector panel found:'
    );
  });

  document.addEventListener('filterSystem', () => {
    handlePanelToggle('system', 'System filter clicked', 'System panel found:');
  });

  document.addEventListener('filterDirection', () => {
    handlePanelToggle(
      'direction',
      'Direction filter clicked',
      'Direction panel found:'
    );
  });

  document.addEventListener('clearFilters', async () => {
    console.log('Clear all filters clicked');
    closeAllPanels();
    // Clear route selector visual state
    const routeSelector = document.querySelector(
      'route-selector-panel'
    ) as IRouteSelectorElement;
    if (routeSelector) routeSelector.clearSelection();
    await filterController.restoreDefaultState(getEffectiveLocation());
    urlSyncManager.clearURL();
  });
};

const registerZoomAndMapEvents = (): void => {
  document.addEventListener('zoomIn', () => {
    console.log('Zoom in clicked');
    const currentZoom = mapProvider.getZoom();
    mapProvider.setZoom(currentZoom + 1);
  });

  document.addEventListener('zoomOut', () => {
    console.log('Zoom out clicked');
    const currentZoom = mapProvider.getZoom();
    mapProvider.setZoom(currentZoom - 1);
  });

  document.addEventListener('recenter', () => {
    console.log('Recenter clicked');
    const loc = getEffectiveLocation();
    mapProvider.setCenter(loc);
    mapProvider.setZoom(15);
    console.log('Recentered map on effective location');
  });

  document.addEventListener('locationShown', (e: Event) => {
    const customEvent = e as CustomEvent;
    console.log('Location shown:', customEvent.detail);
  });

  document.addEventListener('themeChanged', (e: Event) => {
    const customEvent = e as CustomEvent;
    const isDark = customEvent.detail.isDark;
    console.log('Theme changed to:', isDark ? 'dark' : 'light');
    // TODO: Update map theme if needed
  });
};

const registerFilterApplicationEvents = (): void => {
  document.addEventListener('systemFilterApplied', async (e: Event) => {
    const customEvent = e as CustomEvent;
    const { prt, cmu } = customEvent.detail;
    console.log('System filters applied - PRT:', prt, 'CMU:', cmu);
    mapStateManager.updateFilter('selectedSystems', { prt, cmu });
    await filterController.applySystemFilter();
  });

  document.addEventListener('directionFilterApplied', async (e: Event) => {
    const customEvent = e as CustomEvent;
    const { inbound, outbound } = customEvent.detail;
    console.log(
      'Direction filters applied - Inbound:',
      inbound,
      'Outbound:',
      outbound
    );
    mapStateManager.updateFilter('selectedDirections', { inbound, outbound });
    await filterController.applyDirectionFilter();
  });
};

function updateBellState(routeId: string, subscribed: boolean): void {
  const bell = document.querySelector('route-bell') as IRouteBellElement | null;
  bell?.showBell(routeId, subscribed);
}

function getRouteToastLabel(routeId: string): string {
  return getRouteTitle(routeId, mapStateManager.getState().availableRoutes);
}

const registerSubscriptionEvents = (): void => {
  document.addEventListener('bellSubscribe', async (e: Event) => {
    const { routeId } = (e as CustomEvent<{ routeId: string }>).detail;
    const token = localStorage.getItem('token');
    try {
      const res = await axios.post(
        '/notifications/subscriptions',
        { routeId },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true
        }
      );
      if (res.status === 201 && res.data.name === 'RouteSubscribed') {
        authService.addSubscription(routeId);
        document.dispatchEvent(
          new CustomEvent('notifRouteJoin', { detail: { routeId } })
        );
        showSubscriptionToast(`Subscribed to ${getRouteToastLabel(routeId)}.`);
      } else if (
        res.status === 409 &&
        res.data.name === 'SubscriptionLimitReached'
      ) {
        showSubscriptionToast(
          'Subscription limit reached (10). Please remove a subscription first.'
        );
        updateBellState(routeId, false);
      } else if (
        res.status === 409 &&
        res.data.name === 'DuplicateSubscription'
      ) {
        authService.addSubscription(routeId);
        document.dispatchEvent(
          new CustomEvent('notifRouteJoin', { detail: { routeId } })
        );
      } else {
        showSubscriptionToast('Failed to subscribe. Please try again.');
        updateBellState(routeId, false);
      }
    } catch {
      showSubscriptionToast('Failed to subscribe. Please try again.');
      updateBellState(routeId, false);
    }
  });

  document.addEventListener('bellUnsubscribe', async (e: Event) => {
    const { routeId } = (e as CustomEvent<{ routeId: string }>).detail;
    const token = localStorage.getItem('token');
    try {
      const res = await axios.delete(
        `/notifications/subscriptions/${routeId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true
        }
      );
      if (res.status === 200 || res.status === 404) {
        authService.removeSubscription(routeId);
        document.dispatchEvent(
          new CustomEvent('notifRouteLeave', { detail: { routeId } })
        );
        showSubscriptionToast(
          `Unsubscribed from ${getRouteToastLabel(routeId)}.`
        );
      } else {
        showSubscriptionToast('Failed to unsubscribe. Please try again.');
        updateBellState(routeId, true);
      }
    } catch {
      showSubscriptionToast('Failed to unsubscribe. Please try again.');
      updateBellState(routeId, true);
    }
  });
};

const registerBusReportEvents = (): void => {
  document.addEventListener('busReport', (e: Event) => {
    // Gate bus report on GPS permission
    const state = mapStateManager.getState();
    if (!state.gpsPermissionGranted) {
      showModal(
        'GPS Required',
        'Bus report submission requires GPS access. Please enable location services and reload the page.'
      );
      return;
    }

    const { vid, routeId, routeLabel, lat, lon } = (
      e as CustomEvent<{
        vid: string;
        routeId: string;
        routeLabel?: string;
        lat: number;
        lon: number;
      }>
    ).detail;
    const form = document.querySelector(
      'bus-report-form'
    ) as BusReportFormElement | null;
    if (form && typeof form.open === 'function') {
      form.open(vid, routeId, lat, lon, routeLabel);
    }
  });

  document.addEventListener('busReportSubmitted', async (e: Event) => {
    const detail = (e as CustomEvent).detail as Record<string, unknown>;
    const token = localStorage.getItem('token');
    try {
      const res = await axios.post('/notifications/reports', detail, {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true
      });
      if (res.status === 201) {
        showSubscriptionToast(
          res.data.message ?? 'Report submitted. Thank you!'
        );
      } else {
        console.error('Report submission failed:', res.status, res.data);
        const serverMsg: string | undefined = res.data?.message;
        showSubscriptionToast(
          serverMsg ?? 'Failed to submit report. Please try again.'
        );
      }
    } catch (err) {
      console.error('Report submission error:', err);
      showSubscriptionToast('Failed to submit report. Please try again.');
    }
  });
};

const registerRouteSelectionEvents = (): void => {
  document.addEventListener('routeSelected', async (e: Event) => {
    const customEvent = e as CustomEvent<IRouteSelection>;
    const route = customEvent.detail.route;
    if (!route) {
      console.log('Route deselected, returning to nearby stops view');
      await filterController.restoreDefaultState(getEffectiveLocation());
      return;
    }
    console.log('Route selected:', route);
    mapStateManager.updateFilter('selectedRouteId', route);
    await filterController.applyRouteFilter(route);
    await filterController.showRouteInfoPopup(route);
  });
};

// Setup event listeners for web components
function setupMapEventListeners(): void {
  registerTransitSearchEvents();
  registerFilterPanelToggleEvents();
  registerZoomAndMapEvents();
  registerFilterApplicationEvents();
  registerSubscriptionEvents();
  registerBusReportEvents();
  registerRouteSelectionEvents();
  registerLocationSearchEvents();
}

// ─── Location Search Events ──────────────────────────────────────────
const registerLocationSearchEvents = (): void => {
  const locationSearch = document.querySelector(
    'location-search'
  ) as ILocationSearchElement | null;

  // Pass the native Google map to the location-search component for Places API
  if (locationSearch && 'setMap' in locationSearch) {
    const provider =
      mapProvider as import('./maps/google-map.provider').GoogleMapProvider;
    if (typeof provider.getNativeMap === 'function') {
      locationSearch.setMap(provider.getNativeMap());
    }
  }

  // When search bar is focused with no query, open the location search dropdown
  document.addEventListener('searchFocusEmpty', () => {
    locationSearch?.open();
  });

  // When user starts typing in the search bar, close the location dropdown
  document.addEventListener('search', (e: Event) => {
    const query = (e as CustomEvent<{ query: string }>).detail?.query;
    if (query) {
      locationSearch?.close();
    }
  });

  // User selected a custom planned location
  document.addEventListener('locationSelected', (e: Event) => {
    const { lat, lng, label } = (
      e as CustomEvent<{ lat: number; lng: number; label: string }>
    ).detail;
    console.log('Planned location set:', label, lat, lng);
    const plannedLoc = { lat, lng };
    // Hide GPS blue dot, show planned marker
    hideUserLocationMarker();
    addPlannedLocationMarker(lat, lng, label);
    filterController.setUserLocation(plannedLoc);
    filterController.showNearbyStops(plannedLoc);
    directionsController.updatePlannedLocation(plannedLoc);
    mapProvider.setCenter(plannedLoc);
    showSubscriptionToast(`Location set: ${label}`);
  });

  // User reset to current GPS location
  document.addEventListener('locationReset', async () => {
    console.log('Planned location reset to current GPS');
    removePlannedLocationMarker();
    directionsController.updatePlannedLocation(null);
    const state = mapStateManager.getState();
    if (state.currentLocation) {
      showUserLocationMarker();
      filterController.setUserLocation(state.currentLocation);
      await filterController.restoreDefaultState(state.currentLocation);
      mapProvider.setCenter(state.currentLocation);
      showSubscriptionToast('Using current location');
    }
  });
};

// Request user's geographic location (VisRoute Basic Flow step 2-3)
// Uses watchPosition for continuous updates (TUC4 Step 8)
let watchId: number | null = null;
let initialLocationSet = false;

function requestUserLocation(): void {
  if ('geolocation' in navigator) {
    watchId = navigator.geolocation.watchPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;

        // Update state manager with current GPS location
        mapStateManager.setCurrentLocation({ lat, lng });

        // First position: center map and validate area
        if (!initialLocationSet) {
          initialLocationSet = true;
          console.log('User location:', lat, lng);

          if (isInPittsburghArea(lat, lng)) {
            userLocation = { lat, lng };

            // If the user has a custom planned location (mocked location),
            // don't override the map center, blue dot, or nearby stops —
            // those were already set correctly by restorePlannedLocationMarker().
            if (!mapStateManager.hasCustomPlannedLocation()) {
              mapProvider.setCenter({ lat, lng });
              mapProvider.setZoom(15);
              addUserLocationMarker(lat, lng);

              const locationIndicator =
                document.querySelector<LocationIndicator>('location-indicator');
              if (
                locationIndicator &&
                typeof locationIndicator.show === 'function'
              ) {
                locationIndicator.show(lat, lng);
              }
              console.log('Centered map on user location');

              // TUC4 Step 2: Show nearby stops within 1km of user location
              filterController.setUserLocation({ lat, lng });
              filterController.showNearbyStops({ lat, lng });
            } else {
              console.log(
                'Custom planned location active — GPS blue dot suppressed on load'
              );
            }
          } else {
            showModal(
              'Location Out of Bounds',
              'This transit app only supports the Pittsburgh bus system.'
            );
            mapProvider.setCenter({ lat: 40.4406, lng: -80.0112 });
            mapProvider.setZoom(14);
            console.log('Centering on default Pittsburgh location');
          }
        } else {
          // Subsequent positions: update marker, feed directions controller
          userLocation = { lat, lng };
          if (userLocationMarker) {
            userLocationMarker.setPosition({ lat, lng });
          } else if (!mapStateManager.hasCustomPlannedLocation()) {
            // Only create the blue dot if no mocked location is active
            addUserLocationMarker(lat, lng);
          }
          // Keep filter controller in sync for walk-time estimates
          filterController.setUserLocation({ lat, lng });
        }

        // Always feed location to directions controller (TUC4 Step 8)
        directionsController.updateUserLocation({ lat, lng });
        vehicleTracker.updateUserLocation({ lat, lng });
      },
      (error) => {
        if (initialLocationSet) return; // Only show error on first failure
        console.warn('Location access denied:', error.message);

        // Mark GPS as denied in state manager — defaults planned location to CMU
        mapStateManager.setGpsDenied();

        showModal(
          'Location Access Denied',
          'Location access denied. Centering on CMU Campus by default. Bus report submission is disabled without GPS access.'
        );
        // Center on CMU campus and show nearby stops
        centerOnCmuCampus();
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000, // Accept cached position up to 5s old
        timeout: 10000
      }
    );
  } else {
    console.warn('Geolocation not supported');
    mapStateManager.setGpsDenied();
    showModal(
      'Geolocation Unavailable',
      'Geolocation is not supported by your browser. Centering on CMU Campus.'
    );
    centerOnCmuCampus();
  }
}

function centerOnCmuCampus(): void {
  mapProvider.setCenter(CMU_CAMPUS_DEFAULT);
  mapProvider.setZoom(15);
  addPlannedLocationMarker(
    CMU_CAMPUS_DEFAULT.lat,
    CMU_CAMPUS_DEFAULT.lng,
    'CMU Campus'
  );
  filterController.setUserLocation(CMU_CAMPUS_DEFAULT);
  filterController.showNearbyStops(CMU_CAMPUS_DEFAULT);
  directionsController.updatePlannedLocation(CMU_CAMPUS_DEFAULT);
}

// Add a blue dot marker on the map for user location
function addUserLocationMarker(lat: number, lng: number): void {
  // Remove previous user location marker if exists
  if (userLocationMarker) {
    userLocationMarker.remove();
    userLocationMarker = null;
  }

  // Create a blue dot SVG icon for user location
  const size = 18;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 1}" fill="#4285F4" stroke="white" stroke-width="2"/>
    </svg>
  `;
  const icon =
    'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg.trim());

  userLocationMarker = mapProvider.addMarker({
    position: { lat, lng },
    title: 'Your Location',
    icon: icon
  });
  console.log('User location marker added to map');
}

// ── Planned Location Marker ──────────────────────────────────────────
function addPlannedLocationMarker(
  lat: number,
  lng: number,
  label: string
): void {
  removePlannedLocationMarker();

  // Red pin SVG — larger and more prominent than the GPS blue dot
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="48" viewBox="0 0 36 48">
      <path d="M18 0C8.06 0 0 8.06 0 18c0 13.5 18 30 18 30s18-16.5 18-30C36 8.06 27.94 0 18 0z" fill="#C41230"/>
      <circle cx="18" cy="18" r="8" fill="white"/>
      <circle cx="18" cy="18" r="4" fill="#C41230"/>
    </svg>
  `;
  const icon =
    'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg.trim());

  plannedLocationMarker = mapProvider.addMarker({
    position: { lat, lng },
    title: label,
    icon: icon,
    iconSize: { width: 36, height: 48 },
    iconAnchor: { x: 18, y: 48 },
    zIndex: 999
  });

  // Click on planned marker → show remove popup
  plannedLocationMarker.onClick(() => {
    showPlannedLocationPopup(lat, lng, label);
  });
}

function removePlannedLocationMarker(): void {
  if (plannedLocationMarker) {
    plannedLocationMarker.remove();
    plannedLocationMarker = null;
  }
  dismissPlannedLocationPopup();
}

function hideUserLocationMarker(): void {
  if (userLocationMarker) {
    userLocationMarker.setVisible(false);
  }
}

function showUserLocationMarker(): void {
  if (userLocationMarker) {
    userLocationMarker.setVisible(true);
  } else if (userLocation) {
    // Marker was never created (e.g. page loaded with a mocked location active).
    // Create it now that the mocked location has been cleared.
    addUserLocationMarker(userLocation.lat, userLocation.lng);
  }
}

/**
 * Restore persisted planned location marker on page load.
 * If the user previously set a custom planned location, re-show the red pin,
 * hide the GPS blue dot, and center the map on the planned location.
 */
function restorePlannedLocationMarker(): void {
  if (!mapStateManager.hasCustomPlannedLocation()) return;
  const state = mapStateManager.getState();
  if (!state.plannedLocation || !state.plannedLocationLabel) return;

  const { lat, lng } = state.plannedLocation;
  const label = state.plannedLocationLabel;

  addPlannedLocationMarker(lat, lng, label);
  hideUserLocationMarker();

  // Use planned location for nearby stops, map center, and directions
  filterController.setUserLocation({ lat, lng });
  filterController.showNearbyStops({ lat, lng });
  directionsController.updatePlannedLocation({ lat, lng });
  mapProvider.setCenter({ lat, lng });
  mapProvider.setZoom(15);

  console.log('Restored persisted planned location:', label);
}

// ── Planned Location Popup ───────────────────────────────────────────
function dismissPlannedLocationPopup(): void {
  const el = document.getElementById('planned-location-popup');
  if (el) el.remove();
}

function showPlannedLocationPopup(
  lat: number,
  lng: number,
  label: string
): void {
  dismissPlannedLocationPopup();

  const mapContainer = document.querySelector('.map-container');
  if (!mapContainer) return;

  const popup = document.createElement('div');
  popup.id = 'planned-location-popup';
  popup.className = 'planned-location-popup';
  popup.innerHTML = `
    <div class="planned-location-popup__header">
      <span class="material-icons-outlined planned-location-popup__icon">place</span>
      <strong class="planned-location-popup__label">${label}</strong>
    </div>
    <p class="planned-location-popup__desc">Planned location</p>
    <button class="planned-location-popup__remove" id="planned-location-remove">
      <span class="material-icons-outlined">close</span>
      Remove &amp; use current location
    </button>
  `;

  mapContainer.appendChild(popup);

  // Remove button
  document
    .getElementById('planned-location-remove')
    ?.addEventListener('click', async () => {
      dismissPlannedLocationPopup();
      removePlannedLocationMarker();
      mapStateManager.resetPlannedLocationToCurrent();
      directionsController.updatePlannedLocation(null);
      showUserLocationMarker();
      const state = mapStateManager.getState();
      if (state.currentLocation) {
        filterController.setUserLocation(state.currentLocation);
        await filterController.restoreDefaultState(state.currentLocation);
        mapProvider.setCenter(state.currentLocation);
      }
      showSubscriptionToast('Using current location');
    });

  // Close on outside click
  const onOutsideClick = (e: Event) => {
    if (!popup.contains(e.target as Node)) {
      dismissPlannedLocationPopup();
      document.removeEventListener('click', onOutsideClick, true);
    }
  };
  setTimeout(() => document.addEventListener('click', onOutsideClick, true), 0);
}

// ── Toast Notification (TUC4 Step 11) ────────────────────────────────
function showMapToast(message: string): void {
  // Remove existing toast if any
  const existing = document.getElementById('map-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'map-toast';
  toast.className = 'map-toast';
  toast.textContent = message;

  const container = document.querySelector('.map-container');
  if (container) container.appendChild(toast);

  // Auto-dismiss after 4 seconds
  setTimeout(() => {
    toast.classList.add('map-toast--fade');
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

// ── Directions Info Panel (TUC4 Step 6) ──────────────────────────────
let directionsBusTickerInterval: number | null = null;

function stopDirectionsBusTicker(): void {
  if (directionsBusTickerInterval !== null) {
    clearInterval(directionsBusTickerInterval);
    directionsBusTickerInterval = null;
  }
}

function startDirectionsBusTicker(): void {
  stopDirectionsBusTicker();
  directionsBusTickerInterval = window.setInterval(() => {
    const panel = document.getElementById('directions-panel');
    if (!panel) {
      stopDirectionsBusTicker();
      return;
    }
    panel
      .querySelectorAll<HTMLElement>('.directions-panel__bus')
      .forEach((li) => {
        const arrival = Number(li.dataset.arrival);
        if (!arrival) return;
        const timeEl = li.querySelector('.directions-panel__bus-time');
        if (timeEl) timeEl.textContent = formatArrivalCountdown(arrival);
      });
  }, 1000);
}

function formatArrivalCountdown(predictedArrivalTime: number): string {
  const secsLeft = Math.round((predictedArrivalTime - Date.now()) / 1000);
  if (secsLeft <= 0) return 'NOW';
  if (secsLeft < 60) return `${secsLeft}s`;
  return `${Math.ceil(secsLeft / 60)} min`;
}

function getRouteBadgeColor(routeId: string): string {
  const routes = mapStateManager.getState().availableRoutes;
  return routes.find((r) => r.id === routeId)?.color || '#c41230';
}

function updateDirectionsPanel(
  info: {
    durationMin: number;
    eta: string;
    predictions: IPrediction[];
    warnings?: string[];
    loading?: boolean;
  } | null
): void {
  // Remove existing panel
  removeDirectionsPanel();

  if (!info) {
    enableFilterControls();
    return;
  }

  // Disable side filters while viewing walking directions
  disableFilterControls();

  const panel = document.createElement('div');
  panel.id = 'directions-panel';
  panel.className = 'directions-panel';
  panel.dataset.loading = String(Boolean(info.loading));

  const stopName = directionsController.targetStop?.stopName ?? 'Selected Stop';

  let predictionsHTML = '';
  if (info.predictions.length > 0) {
    const items = info.predictions
      .map((p) => {
        const minText = formatArrivalCountdown(p.predictedArrivalTime);
        const color = getRouteBadgeColor(p.routeId);
        return `<li class="directions-panel__bus" data-arrival="${p.predictedArrivalTime}">
          <span class="directions-panel__bus-badge" style="background:${color}">${p.routeId}</span>
          <span class="directions-panel__bus-time">${minText}</span>
          ${p.vid ? `<span class="directions-panel__bus-vid">Bus ${p.vid}</span>` : ''}
        </li>`;
      })
      .join('');
    predictionsHTML = `
      <div class="directions-panel__buses">
        <span class="directions-panel__buses-label">Selected buses arriving:</span>
        <ul class="directions-panel__bus-list">${items}</ul>
      </div>
    `;
  }

  panel.innerHTML = `
    <div class="directions-panel__header">
      <span class="material-icons-outlined directions-panel__icon">directions_walk</span>
      <strong class="directions-panel__title"></strong>
      <button class="directions-panel__close" aria-label="Exit directions">&times;</button>
    </div>
    <div class="directions-panel__info">
      ${
        info.loading
          ? '<span role="status">Finding a walking route…</span>'
          : `<span class="directions-panel__duration">${info.durationMin} min walk</span>
           <span class="directions-panel__eta">ETA ${info.eta}</span>`
      }
    </div>
    ${predictionsHTML}
  `;

  panel.querySelector('.directions-panel__title')!.textContent =
    `Walking to ${stopName}`;
  for (const warning of info.warnings ?? []) {
    const text = document.createElement('p');
    text.className = 'directions-panel__warning';
    text.textContent = warning;
    panel.appendChild(text);
  }

  const container = document.querySelector('.map-container');
  if (container) container.appendChild(panel);

  // Start countdown ticker for bus arrival times
  if (info.predictions.length > 0) startDirectionsBusTicker();

  // Close button: exit directions mode (A4)
  const closeBtn = panel.querySelector('.directions-panel__close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      directionsController.exitDirections();
    });
  }
}

function removeDirectionsPanel(): void {
  stopDirectionsBusTicker();
  const existing = document.getElementById('directions-panel');
  if (existing) existing.remove();
}

// ─── Route-Pick Popup ────────────────────────────────────────────────

/** Dismiss any open route-pick popup. */
function dismissRoutePickPopup(): void {
  const el = document.getElementById('route-pick-popup');
  if (el) el.remove();
}

/** Show a small popup listing route badges at the given pixel position. */
function showRoutePickPopup(routeIds: string[], x: number, y: number): void {
  dismissRoutePickPopup();
  if (routeIds.length === 0) return;

  const mapContainer = document.querySelector('.map-container');
  if (!mapContainer) return;

  const popup = document.createElement('div');
  popup.id = 'route-pick-popup';
  popup.className = 'route-pick-popup';

  routeIds.forEach((id) => {
    const badge = document.createElement('button');
    badge.className = 'route-pick-badge';
    badge.textContent = id;
    badge.style.backgroundColor = routeRenderer.getRouteColor(id);
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissRoutePickPopup();
      document.dispatchEvent(
        new CustomEvent('routeSelected', { detail: { route: id } })
      );
    });
    popup.appendChild(badge);
  });

  popup.style.visibility = 'hidden';
  mapContainer.appendChild(popup);

  // Position relative to map container, clamped to stay in-bounds
  const containerRect = mapContainer.getBoundingClientRect();
  const popupWidth = popup.offsetWidth;
  const popupHeight = popup.offsetHeight;
  const clampedX = Math.min(
    Math.max(x - popupWidth / 2, 8),
    containerRect.width - popupWidth - 8
  );
  const clampedY = Math.min(
    Math.max(y - popupHeight - 12, 8),
    containerRect.height - popupHeight - 8
  );
  popup.style.left = `${clampedX}px`;
  popup.style.top = `${clampedY}px`;
  popup.style.visibility = 'visible';

  // Dismiss when clicking elsewhere
  const onOutsideClick = (e: Event) => {
    if (!popup.contains(e.target as Node)) {
      dismissRoutePickPopup();
      document.removeEventListener('click', onOutsideClick, true);
    }
  };
  // Delay so the current click event doesn't immediately dismiss
  setTimeout(() => document.addEventListener('click', onOutsideClick, true), 0);
}

/** Disable all side filter controls while in directions mode. */
function disableFilterControls(): void {
  closeAllPanels();
  const controls = document.querySelector('map-controls');
  if (controls) controls.classList.add('directions-active');
  // Also disable toggle/filter panels from opening
  const panels = getPanels();
  for (const key of panelOrder) {
    const el = panels[key] as HTMLElement | null;
    if (el) el.classList.add('directions-active');
  }
}

/** Re-enable side filter controls after exiting directions mode. */
function enableFilterControls(): void {
  const controls = document.querySelector('map-controls');
  if (controls) controls.classList.remove('directions-active');
  const panels = getPanels();
  for (const key of panelOrder) {
    const el = panels[key] as HTMLElement | null;
    if (el) el.classList.remove('directions-active');
  }
}

// Check if coordinates are within Pittsburgh area (Rule R5)
function isInPittsburghArea(lat: number, lng: number): boolean {
  const MIN_LAT = 40.1;
  const MAX_LAT = 40.7;
  const MIN_LNG = -80.4;
  const MAX_LNG = -79.6;

  return lat >= MIN_LAT && lat <= MAX_LAT && lng >= MIN_LNG && lng <= MAX_LNG;
}
