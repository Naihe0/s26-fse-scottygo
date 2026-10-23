// HTTP response envelopes shared by the server and the browser.
// Passwords in response payloads are always replaced by a placeholder.

import { IUser, ILogin, IUserAccount } from './user.interface';
import {
  IRoute,
  IVehicle,
  IStop,
  IPrediction,
  IDetour,
  IPattern,
  IBulkTransitData,
  INearbyStopsPayload,
  ISubscription,
  IBusReport,
  INotification,
  IServiceAlert,
  ITransitSearchResult,
  IRouteSchedule
} from './transit.interface';
import { IConfig } from './map.interface';

/** Login response payload. */
export interface IAuthenticatedUser {
  user: IUser;
  token: string; // JWT for the Authorization: Bearer header
}

/** ClientError ↔ 4xx status codes; ServerError ↔ 5xx. */
export type ErrorType = 'ClientError' | 'ServerError' | 'UnknownError';

export type SuccessName =
  | 'UserAuthenticated'
  | 'UserRegistered'
  | 'UserFound'
  | 'UsersRetrieved'
  | 'UserAgreed'
  | 'AccountRetrieved'
  | 'StatusUpdated'
  | 'PrivilegeUpdated'
  | 'UsernameUpdated'
  | 'EmailUpdated'
  | 'PasswordUpdated'
  | 'RoutesRetrieved'
  | 'PathGenerated'
  | 'VehiclesLocated'
  | 'StopsRetrieved'
  | 'PredictionsRetrieved'
  | 'DetoursRetrieved'
  | 'BulkDataRetrieved'
  | 'NearbyStopsRetrieved'
  | 'ConfigFound'
  | 'SubscriptionsRetrieved'
  | 'RouteSubscribed'
  | 'RouteUnsubscribed'
  | 'ReportSubmitted'
  | 'NotificationsRetrieved'
  | 'AlertsRetrieved'
  | 'SearchTransitCompleted'
  | 'RouteScheduleRetrieved'
  | 'UsersSearchCompleted'
  | 'OnboardingCompleted';

export type ClientErrorName =
  | 'MissingEmail'
  | 'MissingUsername'
  | 'MissingPassword'
  | 'MissingToken'
  | 'UnauthorizedRequest'
  | 'InactiveAccount'
  | 'UserNotFound'
  | 'UserExists'
  | 'IncorrectPassword'
  | 'InvalidPassword'
  | 'InvalidEmail'
  | 'InvalidToken'
  | 'WeakPassword'
  | 'InvalidUsername'
  | 'LastAdministrator'
  | 'UsernameExists'
  | 'OutOfBounds'
  | 'RouteNotFound'
  | 'StopNotFound'
  | 'MissingParameter'
  | 'EmptyReport'
  | 'InvalidReportField'
  | 'ProximityViolation'
  | 'VehicleNotFound'
  | 'SubscriptionNotFound'
  | 'DuplicateSubscription'
  | 'SubscriptionLimitReached'
  | 'MissingSearchQuery';

export type ServerErrorName =
  | 'PostRequestFailure'
  | 'GetRequestFailure'
  | 'PatchRequestFailure'
  | 'MongoDBError'
  | 'UpstreamError'
  | 'ReportSubmissionFailure'
  | 'AlertFeedUnavailable';

export type IPayload =
  | IUser
  | ILogin
  | IUser[]
  | IUserAccount
  | IUserAccount[]
  | string[]
  | IAuthenticatedUser
  | IRoute[]
  | IVehicle[]
  | IStop[]
  | IPrediction[]
  | IDetour[]
  | IPattern[]
  | IBulkTransitData
  | INearbyStopsPayload
  | IConfig
  | ISubscription
  | ISubscription[]
  | IBusReport
  | INotification
  | INotification[]
  | IServiceAlert[]
  | ITransitSearchResult
  | IRouteSchedule
  | null;

/** A 2xx response. `payload` holds the result, or null when there is none. */
export interface ISuccess {
  name: SuccessName;
  message?: string;
  /** Username of the authorized requester, for information only. */
  authorizedUser?: string;
  metadata?: Record<string, unknown>;
  payload: IPayload;
}

export type AppErrorName = ClientErrorName | ServerErrorName;

export interface IAppError extends Error {
  type: ErrorType;
  name: AppErrorName;
  message: string;
}

export type IResponse = ISuccess | IAppError;

export function isAppError(res: IResponse): res is IAppError {
  return 'type' in res && 'name' in res && 'message' in res;
}

export function isSuccess(res: IResponse): res is ISuccess {
  return !isAppError(res) && 'name' in res && 'payload' in res;
}
