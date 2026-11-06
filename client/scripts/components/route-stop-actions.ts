import type { IRoute, IStop } from '../../../common/transit.interface';
import { isStopSaved, toggleSavedStop } from '../utils/rider-shortcuts';
import { copyStopLink } from '../utils/stop-link';

function refreshSave(button: HTMLButtonElement): void {
  const saved = isStopSaved(button.dataset.explorerSave!);
  button.textContent = saved ? 'Saved' : 'Save stop';
  button.setAttribute('aria-pressed', String(saved));
}

/** The explorer owns the subscription; updating controls preserves open menus and focus. */
export function refreshRouteStopActions(root: ParentNode): void {
  root
    .querySelectorAll<HTMLButtonElement>('[data-explorer-save]')
    .forEach(refreshSave);
}

/** Optional platform actions stay separate from opening its arrivals. */
export function createRouteStopActions(
  stop: IStop,
  currentRoute: string,
  routes: IRoute[],
  onExploreRoute: (id: string, stop: IStop) => void,
  announce: (text: string) => void
): HTMLElement {
  const details = document.createElement('details');
  details.className = 'route-stop-actions';
  const summary = document.createElement('summary');
  summary.textContent = 'More';
  summary.setAttribute('aria-label', `More actions for ${stop.stopName}`);
  const actions = document.createElement('div');
  actions.className = 'route-stop-actions__buttons';
  const save = document.createElement('button');
  save.type = 'button';
  save.dataset.explorerSave = stop.stopId;
  save.setAttribute(
    'aria-label',
    `Save stop ${stop.stopName} (#${stop.stopId})`
  );
  refreshSave(save);
  save.addEventListener('click', () => {
    if (!details.isConnected) return;
    const result = toggleSavedStop(stop);
    refreshSave(save);
    announce(result.message);
  });
  const share = document.createElement('button');
  share.type = 'button';
  share.dataset.explorerShare = stop.stopId;
  share.textContent = 'Share stop';
  share.addEventListener('click', () => {
    if (details.isConnected) void copyStopLink(stop.stopId, share, announce);
  });
  actions.append(save, share);
  details.append(summary, actions);

  const known = new Map(routes.map((route) => [route.id, route]));
  const candidates = [...new Set(stop.routes ?? [])].filter(
    (id) => id !== currentRoute && /^[A-Za-z0-9_-]{1,80}$/.test(id)
  );
  const transfers = candidates.filter((id) => known.has(id));
  if (transfers.length) {
    const heading = document.createElement('p');
    heading.textContent = 'Explore a connecting route';
    const connections = document.createElement('div');
    connections.className = 'route-stop-actions__connections';
    for (const id of transfers) {
      const route = known.get(id)!;
      const name = route.name?.trim();
      const label =
        route.system === 'CMU'
          ? name || id
          : `Route ${id}${name && name.toLowerCase() !== id.toLowerCase() ? ' · ' + name : ''}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.exploreTransfer = id;
      button.textContent = label;
      button.addEventListener('click', () => {
        if (details.isConnected) onExploreRoute(id, stop);
      });
      connections.append(button);
    }
    details.append(heading, connections);
  } else if (candidates.length) {
    const note = document.createElement('p');
    note.textContent = 'Connecting route details are not available yet.';
    details.append(note);
  }
  details.addEventListener('click', (event) => event.stopPropagation());
  return details;
}
