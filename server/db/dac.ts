// Data access boundary. Models reach the database only through DAC.db, so
// the MongoDB implementation can be replaced with a test double.

import {
  IUser,
  IUserAccount,
  IAccountStatus,
  IPrivilegeLevel
} from '../../common/user.interface';
import {
  ITransitCache,
  ITransitCacheType,
  ISubscription,
  IBusReport,
  INotification
} from '../../common/transit.interface';

export interface IMemorySampleRecord {
  timestamp: Date;
  reason: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  uptimeSec: number;
  peakRssMb: number;
  peakHeapUsedMb: number;
  warning: boolean;
  critical: boolean;
}

export interface IDatabase {
  connect(): Promise<void>;

  /** Drop all collections; refused unless explicitly allowed outside PROD. */
  init(): Promise<void>;

  close(): Promise<void>;

  // Accounts
  saveUser(userData: IUser): Promise<IUser>;

  setUserAgreedToTrue(user: IUser): Promise<IUser | null>;

  findUserAccountByUsername(username: string): Promise<IUserAccount | null>;

  findUserAccountById(userId: string): Promise<IUserAccount | null>;

  updateUserStatus(
    username: string,
    status: IAccountStatus
  ): Promise<IUserAccount | null>;

  updateUserPrivilege(
    username: string,
    privilegeLevel: IPrivilegeLevel
  ): Promise<IUserAccount | null>;

  updateUsername(
    oldUsername: string,
    newUsername: string
  ): Promise<IUserAccount | null>;

  updateUserEmail(
    username: string,
    email: string
  ): Promise<IUserAccount | null>;

  updateUserPassword(
    username: string,
    hashedPassword: string
  ): Promise<IUserAccount | null>;

  /** Number of active administrators. */
  countAdministrators(): Promise<number>;

  markOnboardingComplete(userId: string): Promise<boolean>;

  getAllUsernames(): Promise<string[]>;

  /** Create the initial administrator unless any administrator exists. */
  seedDefaultAdmin(): Promise<void>;

  // Transit cache and diagnostics
  getTransitCache(cacheKey: string): Promise<ITransitCache | null>;

  upsertTransitCache(entry: ITransitCache): Promise<void>;

  clearTransitCache(dataType?: ITransitCacheType): Promise<void>;

  saveMemorySample(sample: IMemorySampleRecord): Promise<void>;

  /** Most recent samples, newest first. */
  getRecentMemorySamples(limit: number): Promise<IMemorySampleRecord[]>;

  // Subscriptions, reports, and notifications
  getSubscriptionsByUserId(userId: string): Promise<ISubscription[]>;

  /** Throws DuplicateSubscription or SubscriptionLimitReached on conflict. */
  saveSubscription(sub: ISubscription): Promise<ISubscription>;

  /** True when a subscription was removed. */
  deleteSubscription(userId: string, routeId: string): Promise<boolean>;

  saveBusReport(report: IBusReport): Promise<IBusReport>;

  saveNotification(notification: INotification): Promise<INotification>;

  /** Notifications from the retention window matching the filter, newest first. */
  getRecentNotifications(
    filter: Record<string, unknown>
  ): Promise<INotification[]>;
}

/** Data Access Class: holds the active database implementation. */
class DAC {
  static db: IDatabase;
}

export default DAC;
