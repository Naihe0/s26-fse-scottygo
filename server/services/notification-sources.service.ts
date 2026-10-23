// Route and vehicle lookups across both transit systems, used by
// subscriptions, report proximity checks, and notification autocomplete.

import { TransitModel } from '../models/transit.model';
import type { IRoute, IVehicle } from '../../common/transit.interface';
import tripshotService from './tripshot.service';
import vehiclePositionsService from './vehicle-positions.service';

class NotificationSourcesService {
  async getAllSubscribableRoutes(): Promise<IRoute[]> {
    const prtRoutes = await TransitModel.getRoutes();
    const cmuRoutes = await tripshotService.getRoutes().catch(() => []);
    return prtRoutes.concat(cmuRoutes);
  }

  async getSubscribableRouteIds(): Promise<Set<string>> {
    const routes = await this.getAllSubscribableRoutes();
    return new Set(routes.map((route) => route.id));
  }

  async getVehiclesForRoute(routeId: string): Promise<IVehicle[]> {
    if (routeId.startsWith('CMU-')) {
      return tripshotService.getVehicles(routeId).catch(() => []);
    }
    return vehiclePositionsService.getVehicles(routeId);
  }

  async getAllLiveVehicles(): Promise<IVehicle[]> {
    const cmuRoutes = await tripshotService.getRoutes().catch(() => []);
    const cmuVehicles = await Promise.all(
      cmuRoutes.map((route) => this.getVehiclesForRoute(route.id))
    );
    return vehiclePositionsService.getAllVehicles().concat(cmuVehicles.flat());
  }
}

export default new NotificationSourcesService();
