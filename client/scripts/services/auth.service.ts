/**
 * Client-side auth and subscription service.
 *
 * Extracted from map.ts so that authentication checks and subscription state
 * management can change independently of the map orchestration logic.
 */

import axios, { AxiosResponse } from 'axios';
import type { IUser, IUserAccount } from '../../../common/user.interface';
import type { IResponse } from '../../../common/server.responses';

function authHeaders(): { Authorization: string } {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}` };
}

export class AuthService {
  private static instance: AuthService;

  /** Local cache of subscribed route IDs — synced from server on load. */
  private subscribedRoutes = new Set<string>();
  private subscriptionToken: string | null = null;

  private currentSubscriptionToken(): string | null {
    const token = localStorage.getItem('token');
    if (token !== this.subscriptionToken) {
      this.subscribedRoutes.clear();
      this.subscriptionToken = token;
    }
    return token;
  }

  private constructor() {}

  static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }
    return AuthService.instance;
  }

  /** Returns true when a valid token and matching user record exist. */
  async isLoggedIn(): Promise<boolean> {
    const token = localStorage.getItem('token');
    if (!token) return false;
    const username = localStorage.getItem('username');
    if (!username) return false;
    const userInDB = await this.getUser(username);
    return userInDB !== null;
  }

  /** Fetches the user record for `username`. Returns null on any failure. */
  async getUser(username: string): Promise<IUser | null> {
    const token = localStorage.getItem('token');
    try {
      const res: AxiosResponse = await axios.request({
        method: 'get',
        headers: { Authorization: `Bearer ${token}` },
        url: '/users/' + encodeURIComponent(username),
        validateStatus: () => true
      });
      if (localStorage.getItem('token') !== token) return null;
      const response: IResponse = res.data;

      if (res.status === 200 && response.name === 'UserFound') {
        return response.payload as IUser;
      }

      if (res.status === 401) {
        // Token invalid or user deleted — clear credentials and redirect.
        console.error('[AuthService] Unauthorized:', response.message);
        localStorage.removeItem('token');
        localStorage.removeItem('username');
        window.location.replace('/auth');
        return null;
      }

      console.error('[AuthService] getUser failed:', res.status, response);
      return null;
    } catch (error) {
      if (localStorage.getItem('token') !== token) return null;
      console.error('[AuthService] getUser error:', error);
      return null;
    }
  }

  /** Fetches the account record for `username` (role, plan, etc.). */
  async getCurrentUserAccount(username: string): Promise<IUserAccount | null> {
    try {
      const res: AxiosResponse = await axios.request({
        method: 'get',
        headers: authHeaders(),
        url: `/account/users/${encodeURIComponent(username)}`,
        validateStatus: () => true
      });
      const response: IResponse = res.data;
      if (res.status === 200 && response.name === 'AccountRetrieved') {
        return response.payload as IUserAccount;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ─── Subscription helpers ────────────────────────────────────────────────

  /** Returns true when the user is locally known to be subscribed to `routeId`. */
  isRouteSubscribed(routeId: string): boolean {
    this.currentSubscriptionToken();
    return this.subscribedRoutes.has(routeId);
  }

  /** Records a local subscription (call after a successful server subscribe). */
  addSubscription(routeId: string): void {
    this.currentSubscriptionToken();
    this.subscribedRoutes.add(routeId);
  }

  /** Removes a local subscription (call after a successful server unsubscribe). */
  removeSubscription(routeId: string): void {
    this.currentSubscriptionToken();
    this.subscribedRoutes.delete(routeId);
  }

  /**
   * Fetches the authoritative subscription list from the server and rebuilds
   * the local cache. Call once during app init so bell icons are accurate.
   */
  async syncSubscriptionsFromServer(): Promise<void> {
    const token = this.currentSubscriptionToken();
    if (!token) return;
    try {
      const res = await axios.get('/notifications/subscriptions', {
        headers: authHeaders(),
        validateStatus: () => true
      });
      if (this.currentSubscriptionToken() !== token) return;
      if (res.status === 200 && res.data.name === 'SubscriptionsRetrieved') {
        this.subscribedRoutes.clear();
        (res.data.payload as { routeId: string }[]).forEach((s) =>
          this.subscribedRoutes.add(s.routeId)
        );
      }
    } catch {
      // Best-effort — bell state may be stale until next load
    }
  }
}

export const authService = AuthService.getInstance();
