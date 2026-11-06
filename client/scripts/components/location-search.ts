/**
 * Location Search Component
 * Choose between GPS, a searched place, the map center, campus or a saved
 * platform. Planned locations never grant GPS privileges.
 *
 * Events emitted:
 * - locationSelected: { lat, lng, label } — user selected a planned location
 * - locationReset: {} — user chose "Current Location" (reset to GPS)
 */
import { MapStateManager } from '../state/map-state';
import { PlaceSuggestions } from './place-suggestions';
import { CAMPUS_CENTER } from '../utils/campus';
import { getRiderShortcuts } from '../utils/rider-shortcuts';

export type ChosenLocation = { lat: number; lng: number; label: string };

export interface ILocationSearchElement extends HTMLElement {
  /** Provide the Google Maps map instance for Places Autocomplete binding */
  setMap(map: google.maps.Map): void;
  /** Open the location dropdown */
  open(): void;
  /** Close the location dropdown */
  close(): void;
  /** Choose coordinates for a saved-place draft without changing the trip. */
  pick(onChosen: (location: ChosenLocation | null) => void): void;
}

export class LocationSearch
  extends HTMLElement
  implements ILocationSearchElement
{
  private dropdown: HTMLElement | null = null;
  private searchContainer: HTMLElement | null = null;
  private placesInput: HTMLInputElement | null = null;
  private autocomplete: PlaceSuggestions | null = null;
  private map: google.maps.Map | null = null;
  private stateManager = MapStateManager.getInstance();
  private unsubscribe?: () => void;
  private onChosen?: (location: ChosenLocation | null) => void;
  private readonly outside = (e: MouseEvent) => {
    const target = e.target as Node;
    if (
      !e.composedPath().includes(this) &&
      !this.contains(target) &&
      !document.querySelector('transit-search')?.contains(target)
    )
      this.close();
  };

  connectedCallback(): void {
    this.innerHTML = `
      <div class="location-search-dropdown" hidden>
        <div class="location-search-default">
          <header class="start-picker__header"><div><strong tabindex="-1" data-start-heading>Starting point</strong><p data-current-start></p></div><button type="button" data-close-start aria-label="Close starting points">×</button></header>
          <div class="location-search-item location-search-current" role="option" tabindex="0">
            <span class="material-icons-outlined location-search-icon">my_location</span>
            <div class="location-search-item-content">
              <span class="location-search-label">Current Location</span>
              <span class="location-search-sublabel" id="location-search-current-sublabel"></span>
            </div>
          </div>
          <div class="location-search-divider"></div>
          <div class="location-search-item location-search-custom" role="option" tabindex="0">
            <span class="material-icons-outlined location-search-icon">edit_location_alt</span>
            <span class="location-search-label">Set a different location</span>
            <span class="material-icons-outlined location-search-arrow">chevron_right</span>
          </div>
          <div class="start-picker__quick"><button type="button" data-campus>Use CMU campus</button><button type="button" data-center>Use map center</button></div>
          <div class="start-picker__stops" hidden><label>Start at a saved stop<select data-start-stop></select></label><button type="button" data-use-stop>Use stop</button></div>
        </div>
        <div class="location-search-places" hidden>
          <div class="location-search-places-header">
            <button class="location-search-back-btn" aria-label="Back">
              <span class="material-icons-outlined">arrow_back</span>
            </button>
            <input
              type="text"
              class="location-search-places-input"
              placeholder="Search for a location..."
              autocomplete="off"
              aria-label="Search for a location"
            />
          </div>
        </div>
      </div>
    `;

    this.dropdown = this.querySelector('.location-search-dropdown');
    this.searchContainer = this.querySelector('.location-search-places');
    this.placesInput = this.querySelector('.location-search-places-input');
    this.querySelector('[data-campus]')!.addEventListener('click', () =>
      this.choose(CAMPUS_CENTER.lat, CAMPUS_CENTER.lng, 'CMU campus')
    );
    this.querySelector('[data-center]')!.addEventListener('click', () => {
      const center = this.map?.getCenter?.();
      if (center) this.choose(center.lat(), center.lng(), 'Map center');
    });
    this.querySelector('[data-use-stop]')!.addEventListener('click', () => {
      const id =
        this.querySelector<HTMLSelectElement>('[data-start-stop]')!.value;
      const stop = getRiderShortcuts().stops.find((s) => s.stopId === id);
      if (stop) this.choose(stop.lat, stop.lon, stop.nickname || stop.stopName);
    });
    this.querySelector('[data-close-start]')!.addEventListener('click', () =>
      this.dismissPicker()
    );
    this.addEventListener('keydown', this.onEscape);
    this.querySelectorAll<HTMLElement>('.location-search-item').forEach(
      (option) => {
        option.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            option.click();
          }
        });
      }
    );

    // "Current Location" click
    this.querySelector('.location-search-current')?.addEventListener(
      'click',
      () => {
        this.handleCurrentLocationClick();
      }
    );

    // "Set a different location" click
    this.querySelector('.location-search-custom')?.addEventListener(
      'click',
      () => {
        this.showPlacesSearch();
      }
    );

    // Back button in search mode
    this.querySelector('.location-search-back-btn')?.addEventListener(
      'click',
      () => {
        this.hidePlacesSearch();
      }
    );

    // Close on outside click (treat transit-search as "inside" since it triggers us)
    document.addEventListener('click', this.outside);

    // Update sublabel when state changes
    this.unsubscribe = this.stateManager.subscribe((state) => {
      const sublabel = this.querySelector('#location-search-current-sublabel');
      if (sublabel) {
        if (state.gpsPermissionGranted && state.currentLocation) {
          sublabel.textContent = 'Using GPS';
        } else {
          sublabel.textContent = 'GPS unavailable';
        }
      }
    });
  }

  setMap(map: google.maps.Map): void {
    this.map = map;
    this.initAutocomplete();
  }

  open(): void {
    if (this.dropdown) {
      this.dropdown.hidden = false;
      this.hidePlacesSearch();
      this.updateCurrentLocationDisplay();
      const state = this.stateManager.getState();
      this.querySelector('[data-start-heading]')!.textContent = this.onChosen
        ? 'Choose a place to save'
        : 'Starting point';
      this.querySelector('[data-current-start]')!.textContent = this.onChosen
        ? 'Choose a location. Your current trip stays as it is.'
        : this.stateManager.hasCustomPlannedLocation()
          ? 'Planning from ' + state.plannedLocationLabel
          : state.gpsPermissionGranted && state.currentLocation
            ? 'Planning from your GPS location'
            : 'Browsing the campus area';
      this.querySelector<HTMLButtonElement>('[data-center]')!.disabled =
        !this.map?.getCenter?.();
      const stops = getRiderShortcuts().stops;
      const select =
        this.querySelector<HTMLSelectElement>('[data-start-stop]')!;
      select.replaceChildren(
        ...stops.map(
          (stop) =>
            new Option(
              (stop.nickname || stop.stopName) + ' · #' + stop.stopId,
              stop.stopId
            )
        )
      );
      this.querySelector<HTMLElement>('.start-picker__stops')!.hidden =
        !stops.length;
    }
  }

  pick(onChosen: (location: ChosenLocation | null) => void): void {
    this.close();
    this.onChosen = onChosen;
    this.open();
    this.querySelector<HTMLElement>('[data-start-heading]')?.focus();
  }

  disconnectedCallback(): void {
    this.close();
    this.unsubscribe?.();
    document.removeEventListener('click', this.outside);
    this.removeEventListener('keydown', this.onEscape);
    this.autocomplete?.dispose();
    this.autocomplete = null;
  }

  private readonly onEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.isComposing || this.dropdown?.hidden) return;
    e.stopPropagation();
    if (this.searchContainer && !this.searchContainer.hidden) {
      this.hidePlacesSearch();
      this.querySelector<HTMLElement>('.location-search-custom')?.focus();
    } else this.dismissPicker();
  };

  private dismissPicker(): void {
    const choosing = !!this.onChosen;
    this.close();
    if (choosing) return;
    document
      .querySelector<HTMLElement>('#layers-btn')
      ?.focus({ preventScroll: true });
  }

  private choose(lat: number, lng: number, label: string): void {
    if (
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      !Number.isFinite(lng) ||
      Math.abs(lng) > 180
    )
      return;
    if (this.onChosen) {
      const chosen = this.onChosen;
      this.onChosen = undefined;
      this.close();
      chosen({ lat, lng, label });
      return;
    }
    this.stateManager.setPlannedLocation({ lat, lng }, label);
    this.close();
    this.dispatchEvent(
      new CustomEvent('locationSelected', {
        detail: { lat, lng, label },
        bubbles: true
      })
    );
  }

  close(): void {
    if (this.dropdown) {
      this.dropdown.hidden = true;
      this.hidePlacesSearch();
    }
    const chosen = this.onChosen;
    this.onChosen = undefined;
    chosen?.(null);
  }

  private updateCurrentLocationDisplay(): void {
    const state = this.stateManager.getState();
    const sublabel = this.querySelector('#location-search-current-sublabel');
    if (sublabel) {
      if (state.gpsPermissionGranted && state.currentLocation) {
        sublabel.textContent = 'Using GPS';
      } else {
        sublabel.textContent = 'GPS unavailable';
      }
    }
  }

  private handleCurrentLocationClick(): void {
    if (this.onChosen) {
      const state = this.stateManager.getState();
      if (state.gpsPermissionGranted && state.currentLocation)
        this.choose(
          state.currentLocation.lat,
          state.currentLocation.lng,
          'Your location'
        );
      else
        this.querySelector('[data-current-start]')!.textContent =
          'GPS is unavailable. Choose a place, the map center or a saved stop.';
      return;
    }
    this.stateManager.resetPlannedLocationToCurrent();
    // The map owns GPS recovery. An unavailable fix is a request to retry,
    // not an explicit choice to persist the automatic campus fallback.
    this.dispatchEvent(new CustomEvent('locationReset', { bubbles: true }));
    this.close();
  }

  private showPlacesSearch(): void {
    const defaultView = this.querySelector(
      '.location-search-default'
    ) as HTMLElement;
    if (defaultView) defaultView.hidden = true;
    if (this.searchContainer) {
      this.searchContainer.hidden = false;
      // Focus the input after a frame to ensure visibility
      requestAnimationFrame(() => {
        this.placesInput?.focus();
      });
    }
  }

  private hidePlacesSearch(): void {
    this.autocomplete?.reset();
    const defaultView = this.querySelector(
      '.location-search-default'
    ) as HTMLElement;
    if (defaultView) defaultView.hidden = false;
    if (this.searchContainer) {
      this.searchContainer.hidden = true;
    }
    if (this.placesInput) this.placesInput.value = '';
  }

  private initAutocomplete(): void {
    if (!this.placesInput || !this.map) return;
    this.autocomplete?.dispose();
    this.autocomplete = new PlaceSuggestions(
      this.placesInput,
      (lat, lng, label) => this.choose(lat, lng, label)
    );
  }
}

customElements.define('location-search', LocationSearch);
