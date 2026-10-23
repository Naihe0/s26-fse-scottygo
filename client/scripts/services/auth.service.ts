// Session validation and the locally cached list of subscribed routes.

import axios from 'axios';
import type { IUser, IUserAccount } from '../../../common/user.interface';
import type { IResponse } from '../../../common/server.responses';
import { mapSignInPath } from '../utils/map-auth-return';
import {
  authHeaders,
  getToken,
  getUsername,
  isSameSession,
  signOut
} from './session';

export class AuthService {
  private static instance: AuthService;

  /** Route IDs the current session is subscribed to, synced from the server. */
  private subscribedRoutes = new Set<string>();
  private subscriptionToken: string | null = null;

  private constructor() {}

  static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }
    return AuthService.instance;
  }

  /** Forget cached subscriptions when a different session signs in. */
  private currentSubscriptionToken(): string | null {
    const token = getToken();
    if (token !== this.subscriptionToken) {
      this.subscribedRoutes.clear();
      this.subscriptionToken = token;
    }
    return token;
  }

  /** True when a stored session still resolves to a user on the server. */
  async isLoggedIn(): Promise<boolean> {
    const username = getUsername();
    if (!getToken() || !username) return false;
    return (await this.getUser(username)) !== null;
  }

  /**
   * The user record for `username`, or null on any failure. An unauthorized
   * response ends the session and returns to sign-in.
   */
  async getUser(username: string): Promise<IUser | null> {
    const token = getToken();
    try {
      const res = await axios.request<IResponse>({
        method: 'get',
        url: `/users/${encodeURIComponent(username)}`,
        headers: authHeaders(),
        validateStatus: () => true
      });
      if (!isSameSession(token)) return null;
      const response = res.data;
      if (res.status === 200 && response.name === 'UserFound') {
        return response.payload as IUser;
      }
      if (res.status === 401) {
        signOut(mapSignInPath());
        return null;
      }
      console.error('[AuthService] getUser failed:', res.status, response);
      return null;
    } catch (error) {
      if (isSameSession(token)) {
        console.error('[AuthService] getUser error:', error);
      }
      return null;
    }
  }

  /** The account record (role, onboarding state) for `username`. */
  async getCurrentUserAccount(username: string): Promise<IUserAccount | null> {
    try {
      const res = await axios.request<IResponse>({
        method: 'get',
        url: `/account/users/${encodeURIComponent(username)}`,
        headers: authHeaders(),
        validateStatus: () => true
      });
      return res.status === 200 && res.data.name === 'AccountRetrieved'
        ? (res.data.payload as IUserAccount)
        : null;
    } catch {
      return null;
    }
  }

  // ── Subscriptions ────────────────────────────────────────────────────

  isRouteSubscribed(routeId: string): boolean {
    this.currentSubscriptionToken();
    return this.subscribedRoutes.has(routeId);
  }

  /** Record a subscription after the server accepted it. */
  addSubscription(routeId: string): void {
    this.currentSubscriptionToken();
    this.subscribedRoutes.add(routeId);
  }

  /** Forget a subscription after the server removed it. */
  removeSubscription(routeId: string): void {
    this.currentSubscriptionToken();
    this.subscribedRoutes.delete(routeId);
  }

  /** Replace the local cache with the server's list so bell icons are accurate. */
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
        this.subscribedRoutes = new Set(
          (res.data.payload as { routeId: string }[]).map((s) => s.routeId)
        );
      }
    } catch {
      // Best effort: bell state may be stale until the next page load.
    }
  }
}

export const authService = AuthService.getInstance();
