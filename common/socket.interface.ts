// Socket.IO event contracts between the browser and the server.

import { IUserAccount } from './user.interface';
import { INotification, IServiceAlert } from './transit.interface';

export type ISearchAutocompleteContext = 'transit' | 'notifications';

export type ISearchSuggestionType =
  | 'route'
  | 'vehicle'
  | 'alert'
  | 'notification';

export interface ISearchSuggestion {
  label: string;
  type: ISearchSuggestionType;
  /** For 'notification' and 'vehicle' suggestions — used by the click handler
   *  to search by route/bus ID instead of the display label. */
  routeId?: string;
  vid?: string;
}

export interface ServerToClientEvents {
  accountUpdated: (account: IUserAccount) => void;
  usernameChanged: (oldUsername: string, newUsername: string) => void;
  forceLogout: (reason: string) => void;
  liveNotification: (notification: INotification) => void;
  alertUpdate: (alerts: IServiceAlert[]) => void;
  searchSuggestions: (suggestions: ISearchSuggestion[]) => void;
}

export interface ClientToServerEvents {
  subscribeAccount: (username: string) => void;
  unsubscribeAccount: (username: string) => void;
  subscribeRoute: (data: { routeId: string }) => void;
  unsubscribeRoute: (data: { routeId: string }) => void;
  searchAutocomplete: (
    query: string,
    context: ISearchAutocompleteContext
  ) => void;
}
