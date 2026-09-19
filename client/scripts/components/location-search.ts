/**
 * Location Search Component
 * Provides a dropdown with "Current Location" and "Set a different location"
 * options. When "Set a different location" is tapped, enables Google Places
 * Autocomplete for arbitrary location search.
 *
 * Events emitted:
 * - locationSelected: { lat, lng, label } — user selected a planned location
 * - locationReset: {} — user chose "Current Location" (reset to GPS)
 */
import { MapStateManager } from '../state/map-state';

export interface ILocationSearchElement extends HTMLElement {
  /** Provide the Google Maps map instance for Places Autocomplete binding */
  setMap(map: google.maps.Map): void;
  /** Open the location dropdown */
  open(): void;
  /** Close the location dropdown */
  close(): void;
}

export class LocationSearch
  extends HTMLElement
  implements ILocationSearchElement
{
  private dropdown: HTMLElement | null = null;
  private searchContainer: HTMLElement | null = null;
  private placesInput: HTMLInputElement | null = null;
  private autocomplete: google.maps.places.Autocomplete | null = null;
  private map: google.maps.Map | null = null;
  private isSearchMode = false;
  private stateManager = MapStateManager.getInstance();

  connectedCallback(): void {
    this.innerHTML = `
      <div class="location-search-dropdown" hidden>
        <div class="location-search-default">
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
    this.querySelectorAll<HTMLElement>('.location-search-item').forEach(
      (option) => {
        option.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            option.click();
          } else if (event.key === 'Escape') {
            this.close();
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
    document.addEventListener('click', (e) => {
      const target = e.target as Node;
      const transitSearch = document.querySelector('transit-search');
      if (!this.contains(target) && !transitSearch?.contains(target)) {
        this.close();
      }
    });

    // Update sublabel when state changes
    this.stateManager.subscribe((state) => {
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
      this.isSearchMode = false;
      this.hidePlacesSearch();
      this.updateCurrentLocationDisplay();
    }
  }

  close(): void {
    if (this.dropdown) {
      this.dropdown.hidden = true;
      this.isSearchMode = false;
      this.hidePlacesSearch();
    }
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
      this.isSearchMode = true;
      // Focus the input after a frame to ensure visibility
      requestAnimationFrame(() => {
        this.placesInput?.focus();
      });
    }
  }

  private hidePlacesSearch(): void {
    const defaultView = this.querySelector(
      '.location-search-default'
    ) as HTMLElement;
    if (defaultView) defaultView.hidden = false;
    if (this.searchContainer) {
      this.searchContainer.hidden = true;
      this.isSearchMode = false;
    }
    if (this.placesInput) this.placesInput.value = '';
  }

  private initAutocomplete(): void {
    if (!this.placesInput || !this.map) return;
    if (typeof google === 'undefined' || !google.maps?.places) return;

    this.autocomplete = new google.maps.places.Autocomplete(this.placesInput, {
      fields: ['geometry', 'name', 'formatted_address'],
      // Bias results toward Pittsburgh area
      bounds: new google.maps.LatLngBounds(
        { lat: 40.1, lng: -80.4 },
        { lat: 40.7, lng: -79.6 }
      )
    });

    this.autocomplete.bindTo('bounds', this.map);

    this.autocomplete.addListener('place_changed', () => {
      const place = this.autocomplete?.getPlace();
      if (!place?.geometry?.location) return;

      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();
      const label =
        place.name || place.formatted_address || 'Selected Location';

      this.stateManager.setPlannedLocation({ lat, lng }, label);

      this.dispatchEvent(
        new CustomEvent('locationSelected', {
          detail: { lat, lng, label },
          bubbles: true
        })
      );

      this.close();
    });
  }
}

customElements.define('location-search', LocationSearch);
