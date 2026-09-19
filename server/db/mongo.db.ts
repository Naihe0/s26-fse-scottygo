// This is the real database, using MongoDB and Mongoose
// It can be initialized with a MongoDB URL pointing to a production or development/test database

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
  INotification
} from '../../common/transit.interface';
import bcrypt from 'bcrypt';
import { randomUUID as uuidV4 } from 'node:crypto';
import { INITIAL_ADMIN_PASSWORD, STAGE } from '../env';
import type { IAppError } from '../../common/server.responses';

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
  { expireAfterSeconds: 7 * 24 * 60 * 60 }
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
  crowdedness: {
    type: String,
    enum: ['Empty', 'Few Seats Taken', 'Standing Room', 'Packed']
  },
  prioritySeating: { type: String, enum: ['Available', 'Occupied'] },
  condition: { type: String, enum: ['Clean', 'Dirty', 'Average'] },
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

// TTL index: auto-delete notifications after 30 minutes (R3)
NotificationSchema.index({ _expiresAt: 1 }, { expireAfterSeconds: 0 });
NotificationSchema.index({ routeId: 1, createdAt: -1 });
NotificationSchema.index({ vid: 1, createdAt: -1 });

const MNotification = model('Notification', NotificationSchema);

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
      // Add error event listener for ongoing issues
      this.db.on('error', (err) => {
        console.error(
          `[MongoDB ${new Date().toISOString()}] Connection error:`,
          err
        );
      });
      console.log(
        `[MongoDB ${new Date().toISOString()}] Connected successfully`
      );
    } catch (err) {
      console.error(
        `[MongoDB ${new Date().toISOString()}] Failed to connect:`,
        err
      );
      throw err; // Prevent app from starting if DB connection fails
    }
  }

  async init(): Promise<void> {
    if (STAGE === 'PROD' || process.env.ALLOW_DB_RESET !== 'true') {
      throw new Error(
        'Database reset requires ALLOW_DB_RESET=true and is forbidden in production'
      );
    }
    // Check if MongoDB is actually connected before trying to drop collections
    // readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
    if (mongoose.connection.readyState !== 1) {
      console.log(
        `[MongoDB ${new Date().toISOString()}] Not connected, reconnecting before init...`
      );
      await this.connect();
    }

    if (this.db == undefined) throw new Error('MongoDB is undefined');

    const collections = this.db.collections;
    // Drop collections entirely (with indexes) instead of just deleting documents like deleteMany
    for (const index in collections) {
      await collections[index].drop();
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      // Remove all event listeners to prevent memory leaks
      // This is important if close() is called and the connection is reused later
      this.db.removeAllListeners();
    }
    await mongoose.disconnect();
  }

  async saveUser(user: IUser): Promise<IUser> {
    const newUser = new MUser(user);
    const savedUser = await newUser.save(); // mongoose document with .toObject() method
    // convert to plain object from mongoose document (which has extra methods/properties) and return
    return savedUser.toObject();
  }

  async findUserByUsername(username: string): Promise<IUser | null> {
    const user: IUser | null = await MUser.findOne({
      'credentials.username': username
    }).lean(); // returns plain object from mongoose document (which has extra methods/properties)
    return user;
  }

  async findUserById(userId: string): Promise<IUser | null> {
    const user: IUser | null = await MUser.findById(userId).lean();
    return user;
  }

  async setUserAgreedToTrue(user: IUser): Promise<IUser | null> {
    const agreedUser: IUser | null = await MUser.findByIdAndUpdate(
      user._id,
      {
        agreed: user.agreed
      },
      {
        new: true // true here returns UPDATED user rather than original
      }
    ).lean();
    return agreedUser;
  }

  // Account management methods

  async findUserAccountByUsername(
    username: string
  ): Promise<IUserAccount | null> {
    const user: IUserAccount | null = await MUser.findOne({
      'credentials.username': username
    }).lean();
    return user;
  }

  async findUserAccountById(userId: string): Promise<IUserAccount | null> {
    const user: IUserAccount | null = await MUser.findById(userId).lean();
    return user;
  }

  async updateUserStatus(
    username: string,
    status: IAccountStatus
  ): Promise<IUserAccount | null> {
    const updatedUser: IUserAccount | null = await MUser.findOneAndUpdate(
      { 'credentials.username': username },
      {
        $set: { status },
        ...(status === 'Inactive' ? { $inc: { tokenVersion: 1 } } : {})
      },
      { new: true }
    ).lean();
    return updatedUser;
  }

  async updateUserPrivilege(
    username: string,
    privilegeLevel: IPrivilegeLevel
  ): Promise<IUserAccount | null> {
    const updatedUser: IUserAccount | null = await MUser.findOneAndUpdate(
      { 'credentials.username': username },
      { privilegeLevel },
      { new: true }
    ).lean();
    return updatedUser;
  }

  async updateUsername(
    oldUsername: string,
    newUsername: string
  ): Promise<IUserAccount | null> {
    const updatedUser: IUserAccount | null = await MUser.findOneAndUpdate(
      { 'credentials.username': oldUsername },
      { 'credentials.username': newUsername },
      { new: true }
    ).lean();
    return updatedUser;
  }

  async updateUserEmail(
    username: string,
    email: string
  ): Promise<IUserAccount | null> {
    const updatedUser: IUserAccount | null = await MUser.findOneAndUpdate(
      { 'credentials.username': username },
      { email },
      { new: true }
    ).lean();
    return updatedUser;
  }

  async updateUserPassword(
    username: string,
    hashedPassword: string
  ): Promise<IUserAccount | null> {
    const updatedUser: IUserAccount | null = await MUser.findOneAndUpdate(
      { 'credentials.username': username },
      {
        $set: { 'credentials.password': hashedPassword },
        $inc: { tokenVersion: 1 }
      },
      { new: true }
    ).lean();
    return updatedUser;
  }

  async countAdministrators(): Promise<number> {
    const count = await MUser.countDocuments({
      privilegeLevel: 'Administrator',
      status: 'Active'
    });
    return count;
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
      console.log(
        `[MongoDB ${new Date().toISOString()}] Default Administrator already exists`
      );
      return;
    }

    // Create default admin user as specified in UC_ManageAcct R2 Initial-Administrator Rule
    const hashedPassword = await bcrypt.hash(INITIAL_ADMIN_PASSWORD, 10);
    const defaultAdmin: IUserAccount = {
      credentials: {
        username: 'admin',
        password: hashedPassword
      },
      email: '', // undefined represented as empty string
      agreed: true, // Default admin is pre-agreed to terms
      _id: uuidV4(),
      status: 'Active',
      privilegeLevel: 'Administrator',
      onboardingComplete: true
    };

    const newAdmin = new MUser(defaultAdmin);
    await newAdmin.save();
    console.log(
      `[MongoDB ${new Date().toISOString()}] Default Administrator user created (username: admin)`
    );
  }

  async getAllUsernames(): Promise<string[]> {
    const users = await MUser.find({}, { 'credentials.username': 1 }).lean();
    return users.map((u) => u.credentials.username);
  }

  // ── Transit Cache Methods ──────────────────────────────────────────────

  async getTransitCache(cacheKey: string): Promise<ITransitCache | null> {
    const entry = await MTransitCache.findOne({ cacheKey }).lean();
    if (!entry) return null;
    // Check if the cache has expired (belt-and-suspenders alongside TTL index)
    if (new Date() > new Date(entry.expiresAt)) return null;
    return entry as ITransitCache;
  }

  async getAllTransitCaches(): Promise<ITransitCache[]> {
    const now = new Date();
    const entries = await MTransitCache.find({
      expiresAt: { $gt: now }
    }).lean();
    return entries as ITransitCache[];
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
    if (dataType) {
      await MTransitCache.deleteMany({ dataType });
    } else {
      await MTransitCache.deleteMany({});
    }
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

  async findSubscription(
    userId: string,
    routeId: string
  ): Promise<ISubscription | null> {
    return (
      (await this.getSubscriptionsByUserId(userId)).find(
        (sub) => sub.routeId === routeId
      ) ?? null
    );
  }

  async countSubscriptionsByUserId(userId: string): Promise<number> {
    return (await this.getSubscriptionsByUserId(userId)).length;
  }

  async saveSubscription(sub: ISubscription): Promise<ISubscription> {
    await this.ensureSubscriptionSet(sub.userId);
    const updated = await MSubscriptionSet.updateOne(
      {
        _id: sub.userId,
        'subscriptions.routeId': { $ne: sub.routeId },
        $expr: { $lt: [{ $size: '$subscriptions' }, 10] }
      },
      { $push: { subscriptions: sub } }
    );
    if (updated.modifiedCount > 0) return sub;

    // This read chooses a user-facing conflict reason; correctness is enforced
    // by the atomic conditional update above, even across multiple app instances.
    const duplicate = await this.findSubscription(sub.userId, sub.routeId);
    throw {
      type: 'ClientError',
      name: duplicate ? 'DuplicateSubscription' : 'SubscriptionLimitReached',
      message: duplicate
        ? `You are already subscribed to Route ${sub.routeId}.`
        : 'Subscription limit reached (10). Please remove a subscription first.'
    } as IAppError;
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
    const doc = new MBusReport(report);
    const saved = await doc.save();
    return saved.toObject();
  }

  async getLatestReportByVehicle(vid: string): Promise<IBusReport | null> {
    return (await MBusReport.findOne({ vid })
      .sort({ createdAt: -1 })
      .lean()) as IBusReport | null;
  }

  async saveNotification(notification: INotification): Promise<INotification> {
    const doc = new MNotification({
      ...notification,
      _expiresAt: new Date(Date.now() + 30 * 60 * 1000)
    });
    const saved = await doc.save();
    const obj = saved.toObject();
    // Remove internal TTL field from returned object
    delete (obj as Record<string, unknown>)._expiresAt;
    return obj as unknown as INotification;
  }

  async getRecentNotifications(
    filter: Record<string, unknown>
  ): Promise<INotification[]> {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const query = { ...filter, createdAt: { $gte: thirtyMinAgo } };
    const docs = await MNotification.find(query).sort({ createdAt: -1 }).lean();
    // Strip internal _expiresAt field
    return docs.map((d) => {
      const { _expiresAt, __v, ...rest } = d as Record<string, unknown>;
      return rest as unknown as INotification;
    });
  }
}
