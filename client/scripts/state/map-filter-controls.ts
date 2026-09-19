import type { IMapState } from './map-state';
import type { TransitSearch } from '../components/transit-search';
import type { IRouteSelectorElement } from '../components/route-selector';
import type { ITogglePanelElement } from '../components/toggle-panel';
import type { ILocationSearchElement } from '../components/location-search';

/** Replace editable drafts with the committed navigation state without events. */
export function synchronizeMapFilterControls(state: Readonly<IMapState>): void {
  const route = document.querySelector<IRouteSelectorElement>(
    'route-selector-panel'
  );
  const system = document.querySelector<ITogglePanelElement>('#system-panel');
  const direction =
    document.querySelector<ITogglePanelElement>('#direction-panel');
  route?.hide();
  system?.hide();
  direction?.hide();
  route?.setSelection(state.selectedRouteId);
  system?.setState(state.selectedSystems);
  direction?.setState(state.selectedDirections);
  document
    .querySelector<TransitSearch>('transit-search')
    ?.setSelection(state.selectedRouteId);
  document.querySelector<ILocationSearchElement>('location-search')?.close();
}
