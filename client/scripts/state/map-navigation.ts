import type { IMapState } from './map-state';

interface NavigationDependencies {
  getState(): Readonly<IMapState>;
  updateFilters(filters: Partial<IMapState>): void;
  resetFilters(): void;
  writeURL(mode: 'replace' | 'push'): void;
  synchronizeControls(): void;
  invalidateRendering(): void;
  directionsActive(): boolean;
  directionsSession(): number;
  render(isCurrent: () => boolean): Promise<boolean>;
  showRouteInfo(routeId: string, isCurrent: () => boolean): Promise<void>;
  onError(): void;
}

/** Owns navigation intent across asynchronous rendering and browser history. */
export class MapNavigationCoordinator {
  private revision = 0;
  private ready = false;
  private disposed = false;
  private cancelPending: (() => void) | null = null;

  constructor(private readonly dependencies: NavigationDependencies) {}

  async start(): Promise<void> {
    this.ready = true;
    await this.restore();
  }

  async commit(
    filters: Partial<IMapState>,
    showRouteInfo = false
  ): Promise<void> {
    this.dependencies.updateFilters(filters);
    this.dependencies.writeURL('push');
    await this.restore(showRouteInfo);
  }

  async clear(): Promise<void> {
    this.dependencies.resetFilters();
    this.dependencies.writeURL('push');
    await this.restore();
  }

  async restore(showRouteInfo = false): Promise<void> {
    const revision = ++this.revision;
    this.cancelPending?.();
    this.dependencies.invalidateRendering();
    this.dependencies.synchronizeControls();
    if (!this.ready || this.disposed || this.dependencies.directionsActive())
      return;
    const session = this.dependencies.directionsSession();
    const token = localStorage.getItem('token');
    const isCurrent = () =>
      !this.disposed &&
      revision === this.revision &&
      session === this.dependencies.directionsSession() &&
      !this.dependencies.directionsActive() &&
      token === localStorage.getItem('token');
    let finish!: () => void;
    const canceled = new Promise<boolean>((resolve) => {
      finish = () => resolve(false);
    });
    this.cancelPending = finish;
    const deadline = window.setTimeout(() => {
      if (!isCurrent()) {
        finish();
        return;
      }
      this.cancel();
      this.dependencies.onError();
    }, 30000);
    try {
      const restored = await Promise.race([
        this.dependencies.render(isCurrent),
        canceled
      ]);
      if (!isCurrent()) return;
      this.dependencies.synchronizeControls();
      this.dependencies.writeURL('replace');
      if (!restored) {
        this.dependencies.onError();
        return;
      }
      const route = this.dependencies.getState().selectedRouteId;
      if (showRouteInfo && route)
        await Promise.race([
          this.dependencies.showRouteInfo(route, isCurrent),
          canceled
        ]);
    } catch {
      if (isCurrent()) this.dependencies.onError();
    } finally {
      window.clearTimeout(deadline);
      if (this.cancelPending === finish) this.cancelPending = null;
    }
  }

  stop(): void {
    this.disposed = true;
    this.cancel();
  }

  cancel(): void {
    this.revision++;
    this.cancelPending?.();
    this.cancelPending = null;
    this.dependencies.invalidateRendering();
  }

  resume(): void {
    this.disposed = false;
    void this.restore();
  }
}
