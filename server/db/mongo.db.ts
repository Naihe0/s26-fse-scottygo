// MongoDB/Mongoose implementation of IDatabase.

import { IDatabase, IMemorySampleRecord } from './dac';
import mongoose from 'mongoose';
import { Schema, model } from 'mongoose';
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
  INotification,
  CROWDEDNESS_LEVELS,
  PRIORITY_SEATING_STATES,
  BUS_CONDITIONS
} from '../../common/transit.interface';
import bcrypt from 'bcrypt';
import { randomUUID as uuidV4 } from 'node:crypto';
import { INITIAL_ADMIN_PASSWORD, STAGE } from '../env';
import { clientError } from '../errors';
import { createLogger } from '../logger';
import { BCRYPT_ROUNDS } from '../models/user.validation';
import {
  MAX_SUBSCRIPTIONS_PER_USER,
  NOTIFICATION_RETENTION_MS
} from '../../common/limits';

const log = createLogger('MongoDB');
const MEMORY_SAMPLE_RETENTION_SECONDS = 7 * 24 * 60 * 60;

// Extended schema for user accounts with status and privilege
const UserSchema = new Schema<IUserAccount>({
  tokenVersion: { type: Number, default: 0 },
  credentials: {
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }
  },
  email: { type: String, required: false }, // Optional to support default admin with undefined email
  agreed: { type: Boolean, required: true },
  _id: { type: String, required: true },
  status: { type: String, default: 'Active', enum: ['Active', 'Inactive'] },
  privilegeLevel: {
    type: String,
    default: 'Member',
    enum: ['Administrator', 'Coordinator', 'Member']
  },
  onboardingComplete: { type: Boolean, default: false }
});

const MUser = model<IUserAccount>('User', UserSchema);

// ── Transit Cache Schema ───────────────────────────────────────────────
const TransitCacheSchema = new Schema<ITransitCache>({
  cacheKey: { type: String, required: true, unique: true },
  dataType: {
    type: String,
    required: true,
    enum: ['routes', 'stops', 'patterns', 'detours']
  },
  data: { type: Schema.Types.Mixed, required: true },
  lastUpdated: { type: Date, required: true },
  expiresAt: { type: Date, required: true }
});

// TTL index: MongoDB automatically removes expired documents
TransitCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const MTransitCache = model<ITransitCache>('TransitCache', TransitCacheSchema);

// ── Memory Monitor Schema ──────────────────────────────────────────────
const MemorySampleSchema = new Schema<IMemorySampleRecord>({
  timestamp: { type: Date, required: true },
  reason: { type: String, required: true },
  rssMb: { type: Number, required: true },
  heapUsedMb: { type: Number, required: true },
  heapTotalMb: { type: Number, required: true },
  externalMb: { type: Number, required: true },
  arrayBuffersMb: { type: Number, required: true },
  uptimeSec: { type: Number, required: true },
  peakRssMb: { type: Number, required: true },
  peakHeapUsedMb: { type: Number, required: true },
  warning: { type: Boolean, required: true },
  critical: { type: Boolean, required: true }
});

// Retain memory samples for 7 days to bound database growth.
MemorySampleSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: MEMORY_SAMPLE_RETENTION_SECONDS }
);

const MMemorySample = model<IMemorySampleRecord>(
  'MemorySample',
  MemorySampleSchema
);

// ── Subscription Schema (TUC3) ────────────────────────────────────────
const SubscriptionSchema = new Schema<ISubscription>({
  _id: { type: String, required: true },
  userId: { type: String, required: true },
  routeId: { type: String, required: true },
  createdAt: { type: String, required: true }
});

// Compound unique index: one subscription per user per route
SubscriptionSchema.index({ userId: 1, routeId: 1 }, { unique: true });

const MSubscription = model<ISubscription>('Subscription', SubscriptionSchema);

// Keep a user's bounded subscription list in one document so MongoDB can enforce
// the route uniqueness and ten-route limit in the same atomic update.
interface ISubscriptionSet {
  _id: string;
  subscriptions: ISubscription[];
}
const SubscriptionEntrySchema = new Schema<ISubscription>(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true },
    routeId: { type: String, required: true },
    createdAt: { type: String, required: true }
  },
  { _id: false }
);
const MSubscriptionSet = model<ISubscriptionSet>(
  'SubscriptionSet',
  new Schema<ISubscriptionSet>({
    _id: { type: String, required: true },
    subscriptions: { type: [SubscriptionEntrySchema], default: [] }
  })
);

// ── Bus Report Schema (TUC3) ──────────────────────────────────────────
const BusReportSchema = new Schema<IBusReport>({
  _id: { type: String, required: true },
  userId: { type: String, required: true },
  vid: { type: String, required: true },
  routeId: { type: String, required: true },
  crowdedness: { type: String, enum: CROWDEDNESS_LEVELS },
  prioritySeating: { type: String, enum: PRIORITY_SEATING_STATES },
  condition: { type: String, enum: BUS_CONDITIONS },
  comment: { type: String },
  lat: { type: Number, required: true },
  lon: { type: Number, required: true },
  createdAt: { type: String, required: true }
});

BusReportSchema.index({ vid: 1, createdAt: -1 });

const MBusReport = model<IBusReport>('BusReport', BusReportSchema);

// ── Notification Schema (TUC3) ────────────────────────────────────────
const NotificationSchema = new Schema({
  _id: { type: String, required: true },
  routeId: { type: String, required: true },
  vid: { type: String, required: true },
  message: { type: String, required: true },
  changedFields: [{ type: String }],
  reportId: { type: String, required: true },
  createdAt: { type: String, required: true },
  _expiresAt: { type: Date, required: true }
});

// TTL index: MongoDB deletes each notification at its _expiresAt time.
NotificationSchema.index({ _expiresAt: 1 }, { expireAfterSeconds: 0 });
NotificationSchema.index({ routeId: 1, createdAt: -1 });
NotificationSchema.index({ vid: 1, createdAt: -1 });

const MNotification = model('Notification', NotificationSchema);

/** Strip storage-only fields before returning a notification to callers. */
function withoutInternalFields(doc: object): INotification {
  const {
    _expiresAt: _expiry,
    __v: _version,
    ...notification
  } = doc as Record<string, unknown>;
  return notification as unknown as INotification;
}

export class MongoDB implements IDatabase {
  public dbURL: string;

  private db: mongoose.Connection | undefined;

  constructor(dbURL: string) {
    this.dbURL = dbURL;
  }

  async connect(): Promise<void> {
    try {
      await mongoose.connect(this.dbURL);
      this.db = mongoose.connection;
      this.db.on('error', (err) => log.error('Connection error:', err));
      log.info('Connected successfully');
    } catch (err) {
      log.error('Failed to connect:', err);
      throw err; // Prevent app from starting if DB connection fails
    }
  }

  async init(): Promise<void> {
    if (STAGE === 'PROD' || process.env.ALLOW_DB_RESET !== 'true') {
      throw new Error(
        'Database reset requires ALLOW_DB_RESET=true and is forbidden in production'
      );
    }
    if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected) {
      log.info('Not connected, reconnecting before init...');
      await this.connect();
    }
    if (!this.db) throw new Error('MongoDB is undefined');

    // Drop collections entirely (with indexes), not just their documents.
    for (const collection of Object.values(this.db.collections)) {
      await collection.drop();
    }
  }

  async close(): Promise<void> {
    // Remove listeners so a reused connection does not accumulate them.
    this.db?.removeAllListeners();
    await mongoose.disconnect();
  }

  async saveUser(user: IUser): Promise<IUser> {
    return (await new MUser(user).save()).toObject();
  }

  async setUserAgreedToTrue(user: IUser): Promise<IUser | null> {
    return MUser.findByIdAndUpdate(
      user._id,
      { agreed: user.agreed },
      { new: true }
    ).lean();
  }

  async findUserAccountByUsername(
    username: string
  ): Promise<IUserAccount | null> {
    return MUser.findOne({ 'credentials.username': username }).lean();
  }

  async findUserAccountById(userId: string): Promise<IUserAccount | null> {
    return MUser.findById(userId).lean();
  }

  async updateUserStatus(
    username: string,
    status: IAccountStatus
  ): Promise<IUserAccount | null> {
    // Deactivation revokes previously issued sessions.
    return this.updateAccount(username, {
      $set: { status },
      ...(status === 'Inactive' ? { $inc: { tokenVersion: 1 } } : {})
    });
  }

  async updateUserPrivilege(
    username: string,
    privilegeLevel: IPrivilegeLevel
  ): Promise<IUserAccount | null> {
    return this.updateAccount(username, { privilegeLevel });
  }

  async updateUsername(
    oldUsername: string,
    newUsername: string
  ): Promise<IUserAccount | null> {
    return this.updateAccount(oldUsername, {
      'credentials.username': newUsername
    });
  }

  async updateUserEmail(
    username: string,
    email: string
  ): Promise<IUserAccount | null> {
    return this.updateAccount(username, { email });
  }

  async updateUserPassword(
    username: string,
    hashedPassword: string
  ): Promise<IUserAccount | null> {
    // A password change revokes previously issued sessions.
    return this.updateAccount(username, {
      $set: { 'credentials.password': hashedPassword },
      $inc: { tokenVersion: 1 }
    });
  }

  private async updateAccount(
    username: string,
    update: mongoose.UpdateQuery<IUserAccount>
  ): Promise<IUserAccount | null> {
    return MUser.findOneAndUpdate(
      { 'credentials.username': username },
      update,
      { new: true }
    ).lean();
  }

  async countAdministrators(): Promise<number> {
    return MUser.countDocuments({
      privilegeLevel: 'Administrator',
      status: 'Active'
    });
  }

  async markOnboardingComplete(userId: string): Promise<boolean> {
    const result = await MUser.updateOne(
      { _id: userId },
      { onboardingComplete: true }
    );
    return result.modifiedCount > 0;
  }

  async seedDefaultAdmin(): Promise<void> {
    // Check if default admin already exists
    const existingAdmin = await MUser.findOne({
      $or: [
        { 'credentials.username': 'admin' },
        { privilegeLevel: 'Administrator' }
      ]
    });

    if (existingAdmin) {
      log.info('Default Administrator already exists');
      return;
    }

    // The system must always have at least one administrator.
    const defaultAdmin: IUserAccount = {
      credentials: {
        username: 'admin',
        password: await bcrypt.hash(INITIAL_ADMIN_PASSWORD, BCRYPT_ROUNDS)
      },
      email: '',
      agreed: true,
      _id: uuidV4(),
      status: 'Active',
      privilegeLevel: 'Administrator',
      onboardingComplete: true
    };
    await new MUser(defaultAdmin).save();
    log.info('Default Administrator user created (username: admin)');
  }

  async getAllUsernames(): Promise<string[]> {
    const users = await MUser.find({}, { 'credentials.username': 1 }).lean();
    return users.map((u) => u.credentials.username);
  }

  // ── Transit Cache Methods ──────────────────────────────────────────────

  async getTransitCache(cacheKey: string): Promise<ITransitCache | null> {
    const entry = await MTransitCache.findOne({ cacheKey }).lean();
    // The TTL index removes expired entries only periodically.
    if (!entry || new Date() > new Date(entry.expiresAt)) return null;
    return entry as ITransitCache;
  }

  async upsertTransitCache(entry: ITransitCache): Promise<void> {
    await MTransitCache.findOneAndUpdate(
      { cacheKey: entry.cacheKey },
      {
        cacheKey: entry.cacheKey,
        dataType: entry.dataType,
        data: entry.data,
        lastUpdated: entry.lastUpdated,
        expiresAt: entry.expiresAt
      },
      { upsert: true, new: true }
    );
  }

  async clearTransitCache(dataType?: ITransitCacheType): Promise<void> {
    await MTransitCache.deleteMany(dataType ? { dataType } : {});
  }

  async saveMemorySample(sample: IMemorySampleRecord): Promise<void> {
    await MMemorySample.create(sample);
  }

  async getRecentMemorySamples(limit: number): Promise<IMemorySampleRecord[]> {
    const docs = await MMemorySample.find({})
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
    return docs as IMemorySampleRecord[];
  }

  // ── Notification (TUC3) Methods ──────────────────────────────────────

  async getSubscriptionsByUserId(userId: string): Promise<ISubscription[]> {
    await this.ensureSubscriptionSet(userId);
    return (
      (await MSubscriptionSet.findById(userId).lean())?.subscriptions ?? []
    );
  }

  async saveSubscription(sub: ISubscription): Promise<ISubscription> {
    await this.ensureSubscriptionSet(sub.userId);
    const updated = await MSubscriptionSet.updateOne(
      {
        _id: sub.userId,
        'subscriptions.routeId': { $ne: sub.routeId },
        $expr: {
          $lt: [{ $size: '$subscriptions' }, MAX_SUBSCRIPTIONS_PER_USER]
        }
      },
      { $push: { subscriptions: sub } }
    );
    if (updated.modifiedCount > 0) return sub;

    // This read chooses a user-facing conflict reason; correctness is enforced
    // by the atomic conditional update above, even across multiple app instances.
    const existing = await this.getSubscriptionsByUserId(sub.userId);
    if (existing.some((saved) => saved.routeId === sub.routeId)) {
      throw clientError(
        'DuplicateSubscription',
        `You are already subscribed to Route ${sub.routeId}.`
      );
    }
    throw clientError(
      'SubscriptionLimitReached',
      `Subscription limit reached (${MAX_SUBSCRIPTIONS_PER_USER}). Please remove a subscription first.`
    );
  }

  async deleteSubscription(userId: string, routeId: string): Promise<boolean> {
    await this.ensureSubscriptionSet(userId);
    const result = await MSubscriptionSet.updateOne(
      { _id: userId },
      { $pull: { subscriptions: { routeId } } }
    );
    return result.modifiedCount > 0;
  }

  private async ensureSubscriptionSet(userId: string): Promise<void> {
    if (await MSubscriptionSet.exists({ _id: userId })) return;
    // Lazy, non-destructive migration: first writer wins initialization; later
    // readers never re-import records removed from the new authoritative set.
    const legacy = await MSubscription.find({ userId }).lean();
    try {
      await MSubscriptionSet.updateOne(
        { _id: userId },
        {
          $setOnInsert: { subscriptions: legacy }
        },
        { upsert: true }
      );
    } catch (error) {
      // Simultaneous first access may race on the _id unique index.
      if (
        !(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 11000
        )
      )
        throw error;
    }
  }

  async saveBusReport(report: IBusReport): Promise<IBusReport> {
    return (await new MBusReport(report).save()).toObject();
  }

  async saveNotification(notification: INotification): Promise<INotification> {
    const saved = await new MNotification({
      ...notification,
      _expiresAt: new Date(Date.now() + NOTIFICATION_RETENTION_MS)
    }).save();
    return withoutInternalFields(saved.toObject());
  }

  async getRecentNotifications(
    filter: Record<string, unknown>
  ): Promise<INotification[]> {
    // The TTL index deletes lazily; filter the retention window explicitly.
    const since = new Date(
      Date.now() - NOTIFICATION_RETENTION_MS
    ).toISOString();
    const docs = await MNotification.find({
      ...filter,
      createdAt: { $gte: since }
    })
      .sort({ createdAt: -1 })
      .lean();
    return docs.map(withoutInternalFields);
  }
}
