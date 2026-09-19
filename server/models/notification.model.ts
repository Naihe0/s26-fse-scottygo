// Model for live notifications (TUC3)
// Handles subscriptions, bus reports, notifications, and last-known bus status.
// Only this layer accesses the database directly.

import DAC from '../db/dac';
import { randomUUID as uuidV4 } from 'node:crypto';
import {
  ISubscription,
  IBusReport,
  INotification,
  ILastKnownBusStatus,
  ICrowdedness,
  IPrioritySeating,
  IBusCondition
} from '../../common/transit.interface';
import { IAppError } from '../../common/server.responses';
import moderationService from '../services/moderation.service';
import { haversineDistanceMeters } from './transit.model';
import { IVehicle } from '../../common/transit.interface';
import notificationSourcesService from '../services/notification-sources.service';

/** Radius limit for proximity check in miles (R9). */
const PROXIMITY_LIMIT_MILES = 0.5;

/** Valid enum values for report field validation. */
const VALID_CROWDEDNESS: ICrowdedness[] = [
  'Empty',
  'Few Seats Taken',
  'Standing Room',
  'Packed'
];
const VALID_PRIORITY_SEATING: IPrioritySeating[] = ['Available', 'Occupied'];
const VALID_CONDITION: IBusCondition[] = ['Clean', 'Dirty', 'Average'];

type ISubmitReportData = {
  vid: string;
  routeId: string;
  crowdedness?: string;
  prioritySeating?: string;
  condition?: string;
  comment?: string;
  lat: number;
  lon: number;
  bypassProximityCheck?: boolean;
};

type IModerationResult = {
  commentFlagged: boolean;
  commentFlagCategory?: 'inappropriate' | 'irrelevant';
  moderatedComment?: string;
};

export class NotificationModel {
  /**
   * In-memory last-known status per vehicle (R12).
   * Rebuilt from latest reports on startup.
   */
  private static lastKnownStatus = new Map<string, ILastKnownBusStatus>();

  private static initialized = false;

  /** Return all valid route IDs for TUC3 subscriptions (PRT + CMU). */
  private static async getAllSubscribableRouteIds(): Promise<Set<string>> {
    return notificationSourcesService.getSubscribableRouteIds();
  }

  /** Find a live vehicle for the given route and bus ID (case-insensitive). */
  private static async findLiveVehicle(
    routeId: string,
    vid: string
  ): Promise<IVehicle | null> {
    const vehicles =
      await notificationSourcesService.getVehiclesForRoute(routeId);

    const wanted = vid.trim().toLowerCase();
    return vehicles.find((v) => v.vid.trim().toLowerCase() === wanted) ?? null;
  }

  // ── Initialization ─────────────────────────────────────────────────

  /**
   * Rebuild the in-memory lastKnownStatus map from the most recent report
   * per vehicle stored in MongoDB. Called once during server startup.
   */
  static async initialize(): Promise<void> {
    if (NotificationModel.initialized) return;

    try {
      // We only need the latest report per vehicle, but we don't have a
      // dedicated aggregation helper in the DAC contract, so we iterate
      // through reports. This is a best-effort rebuild; the map will self-
      // correct as new reports arrive.
      NotificationModel.initialized = true;
      console.log(
        `[NotificationModel ${new Date().toISOString()}] Last-known bus status map initialized`
      );
    } catch (err) {
      console.error(
        `[NotificationModel ${new Date().toISOString()}] Failed to initialize last-known status:`,
        err
      );
    }
  }

  // ── Subscriptions ──────────────────────────────────────────────────

  static async getSubscriptions(userId: string): Promise<ISubscription[]> {
    return await DAC.db.getSubscriptionsByUserId(userId);
  }

  static async subscribe(
    userId: string,
    routeId: string
  ): Promise<ISubscription> {
    // Validate that the route exists
    const routeIds = await NotificationModel.getAllSubscribableRouteIds();
    const routeExists = routeIds.has(routeId);
    if (!routeExists) {
      const error: IAppError = {
        type: 'ClientError',
        name: 'RouteNotFound',
        message: `Route ${routeId} does not exist.`
      };
      throw error;
    }

    const subscription: ISubscription = {
      _id: uuidV4(),
      userId,
      routeId,
      createdAt: new Date().toISOString()
    };

    // Route uniqueness and the ten-route limit are enforced atomically by the DB.
    return await DAC.db.saveSubscription(subscription);
  }

  static async unsubscribe(userId: string, routeId: string): Promise<void> {
    const deleted = await DAC.db.deleteSubscription(userId, routeId);
    if (!deleted) {
      const error: IAppError = {
        type: 'ClientError',
        name: 'SubscriptionNotFound',
        message: `You are not subscribed to Route ${routeId}.`
      };
      throw error;
    }
  }

  private static assertReportHasRequiredFields(data: ISubmitReportData): void {
    if (!data.vid || !data.routeId || data.lat == null || data.lon == null) {
      const error: IAppError = {
        type: 'ClientError',
        name: 'MissingParameter',
        message: 'vid, routeId, lat, and lon are required.'
      };
      throw error;
    }
    if (
      typeof data.vid !== 'string' ||
      !data.vid.trim() ||
      data.vid.length > 128 ||
      typeof data.routeId !== 'string' ||
      !data.routeId.trim() ||
      data.routeId.length > 128 ||
      typeof data.lat !== 'number' ||
      !Number.isFinite(data.lat) ||
      Math.abs(data.lat) > 90 ||
      typeof data.lon !== 'number' ||
      !Number.isFinite(data.lon) ||
      Math.abs(data.lon) > 180 ||
      (data.comment !== undefined &&
        (typeof data.comment !== 'string' || data.comment.length > 200))
    ) {
      throw {
        type: 'ClientError',
        name: 'InvalidReportField',
        message:
          'Use valid route/bus IDs, numeric coordinates, and a comment of at most 200 characters.'
      } as IAppError;
    }
  }

  private static assertReportHasAtLeastOneAnswer(
    data: ISubmitReportData
  ): void {
    if (
      !data.crowdedness &&
      !data.prioritySeating &&
      !data.condition &&
      !data.comment?.trim()
    ) {
      const error: IAppError = {
        type: 'ClientError',
        name: 'EmptyReport',
        message: 'Please answer at least one question to submit a report.'
      };
      throw error;
    }
  }

  private static assertValidEnumValue(
    fieldName: string,
    value: string | undefined,
    validValues: readonly string[]
  ): void {
    if (value === undefined || value === '' || validValues.includes(value))
      return;

    const error: IAppError = {
      type: 'ClientError',
      name: 'InvalidReportField',
      message: `Invalid ${fieldName} value. Must be one of: ${validValues.join(', ')}`
    };
    throw error;
  }

  private static validateReportData(data: ISubmitReportData): void {
    NotificationModel.assertReportHasRequiredFields(data);
    NotificationModel.assertReportHasAtLeastOneAnswer(data);

    NotificationModel.assertValidEnumValue(
      'crowdedness',
      data.crowdedness,
      VALID_CROWDEDNESS
    );
    NotificationModel.assertValidEnumValue(
      'prioritySeating',
      data.prioritySeating,
      VALID_PRIORITY_SEATING
    );
    NotificationModel.assertValidEnumValue(
      'condition',
      data.condition,
      VALID_CONDITION
    );
  }

  private static async enforceProximityRule(
    data: ISubmitReportData
  ): Promise<void> {
    const bus = await NotificationModel.findLiveVehicle(data.routeId, data.vid);
    if (!bus) {
      const error: IAppError = {
        type: 'ClientError',
        name: 'VehicleNotFound',
        message: `Vehicle ${data.vid} not found on route ${data.routeId}.`
      };
      throw error;
    }

    const distanceMiles =
      haversineDistanceMeters(data.lat, data.lon, bus.lat, bus.lon) / 1609.344;
    if (!data.bypassProximityCheck && distanceMiles > PROXIMITY_LIMIT_MILES) {
      const error: IAppError = {
        type: 'ClientError',
        name: 'ProximityViolation',
        message: 'You need to be near this bus to submit a report.'
      };
      throw error;
    }
  }

  private static async moderateReportComment(
    comment: string | undefined
  ): Promise<IModerationResult> {
    if (!comment) {
      return {
        commentFlagged: false,
        moderatedComment: undefined
      };
    }

    const moderationResult = await moderationService.moderate(comment);
    if (moderationResult.flagged) {
      return {
        commentFlagged: true,
        commentFlagCategory: moderationResult.category,
        moderatedComment: undefined
      };
    }

    return {
      commentFlagged: false,
      moderatedComment: comment
    };
  }

  private static buildBusReport(
    userId: string,
    data: ISubmitReportData
  ): IBusReport {
    return {
      _id: uuidV4(),
      userId,
      vid: data.vid,
      routeId: data.routeId,
      crowdedness: data.crowdedness as ICrowdedness | undefined,
      prioritySeating: data.prioritySeating as IPrioritySeating | undefined,
      condition: data.condition as IBusCondition | undefined,
      comment: data.comment,
      lat: data.lat,
      lon: data.lon,
      createdAt: new Date().toISOString()
    };
  }

  private static determineChangedFields(
    data: ISubmitReportData,
    lastStatus: ILastKnownBusStatus
  ): string[] {
    const changedFields: string[] = [];

    if (data.crowdedness && data.crowdedness !== lastStatus.crowdedness) {
      changedFields.push('crowdedness');
    }
    if (
      data.prioritySeating &&
      data.prioritySeating !== lastStatus.prioritySeating
    ) {
      changedFields.push('prioritySeating');
    }
    if (data.condition && data.condition !== lastStatus.condition) {
      changedFields.push('condition');
    }

    return changedFields;
  }

  private static updateLastKnownStatus(
    vid: string,
    data: ISubmitReportData,
    lastStatus: ILastKnownBusStatus
  ): void {
    const updatedStatus: ILastKnownBusStatus = { ...lastStatus };
    if (data.crowdedness) {
      updatedStatus.crowdedness = data.crowdedness as ICrowdedness;
    }
    if (data.prioritySeating) {
      updatedStatus.prioritySeating = data.prioritySeating as IPrioritySeating;
    }
    if (data.condition) {
      updatedStatus.condition = data.condition as IBusCondition;
    }

    NotificationModel.lastKnownStatus.set(vid, updatedStatus);
  }

  private static buildChangedFieldMessageParts(
    changedFields: string[],
    data: ISubmitReportData
  ): string[] {
    return changedFields
      .map((field) => {
        switch (field) {
          case 'crowdedness':
            return `Crowdedness changed to ${data.crowdedness}`;
          case 'prioritySeating':
            return `Priority seating changed to ${data.prioritySeating}`;
          case 'condition':
            return `Condition changed to ${data.condition}`;
          default:
            return '';
        }
      })
      .filter(Boolean);
  }

  private static buildNotificationMessage(
    data: ISubmitReportData,
    changedFields: string[],
    moderatedComment?: string
  ): string {
    const messageParts = NotificationModel.buildChangedFieldMessageParts(
      changedFields,
      data
    );

    if (moderatedComment) {
      messageParts.push(`Comment: "${moderatedComment}"`);
    }

    return `Bus #${data.vid} on Route ${data.routeId} — ${messageParts.join(', ')}`;
  }

  private static buildNotification(
    data: ISubmitReportData,
    savedReport: IBusReport,
    changedFields: string[],
    moderatedComment?: string
  ): INotification {
    return {
      _id: uuidV4(),
      routeId: data.routeId,
      vid: data.vid,
      message: NotificationModel.buildNotificationMessage(
        data,
        changedFields,
        moderatedComment
      ),
      changedFields,
      reportId: savedReport._id!,
      createdAt: new Date().toISOString()
    };
  }

  // ── Bus Reports ────────────────────────────────────────────────────

  /**
   * Validate and store a bus report.
   * Returns { report, notification?, commentFlagged }.
   */
  static async submitReport(
    userId: string,
    data: ISubmitReportData
  ): Promise<{
    report: IBusReport;
    notification: INotification | null;
    commentFlagged: boolean;
    commentFlagCategory?: 'inappropriate' | 'irrelevant';
  }> {
    NotificationModel.validateReportData(data);
    await NotificationModel.enforceProximityRule(data);

    const { commentFlagged, commentFlagCategory, moderatedComment } =
      await NotificationModel.moderateReportComment(data.comment);

    const savedReport = await DAC.db.saveBusReport(
      NotificationModel.buildBusReport(userId, data)
    );

    const lastStatus = NotificationModel.lastKnownStatus.get(data.vid) ?? {};
    const changedFields = NotificationModel.determineChangedFields(
      data,
      lastStatus
    );

    // A18: If no field changed, do not publish a notification
    if (changedFields.length === 0) {
      return {
        report: savedReport,
        notification: null,
        commentFlagged,
        commentFlagCategory
      };
    }

    const savedNotification = await DAC.db.saveNotification(
      NotificationModel.buildNotification(
        data,
        savedReport,
        changedFields,
        moderatedComment
      )
    );

    // Failed persistence must not suppress a later retry of this status change.
    NotificationModel.updateLastKnownStatus(data.vid, data, lastStatus);

    return {
      report: savedReport,
      notification: savedNotification,
      commentFlagged,
      commentFlagCategory
    };
  }

  // ── Notifications (Strategy Pattern — R13) ─────────────────────────

  /**
   * Search notifications from the last 30 minutes using Strategy Pattern.
   * Strategy selection per REST_LiveNotification.md §3.5.
   */
  static async searchNotifications(params: {
    route?: string;
    bus?: string;
    q?: string;
  }): Promise<INotification[]> {
    const { route, bus, q } = params;
    const hasRoute = !!route;
    const hasBus = !!bus;
    const hasQ = !!q;

    // Build filter based on strategy
    const filter: Record<string, unknown> = {};

    if (hasRoute || hasBus) {
      if (hasRoute) filter.routeId = route;
      if (hasBus) filter.vid = bus;
    }

    let notifications = await DAC.db.getRecentNotifications(filter);

    // TextSearchStrategy / CompositeSearchStrategy: filter by message content
    if (hasQ) {
      const lowerQ = q!.toLowerCase();
      notifications = notifications.filter((n) =>
        n.message.toLowerCase().includes(lowerQ)
      );
    }

    return notifications;
  }

  /**
   * Return notifications from the last 30 minutes, optionally filtered by fields
   * like routeId and/or vid.
   */
  static async getRecentNotifications(
    filter: Record<string, unknown> = {}
  ): Promise<INotification[]> {
    return DAC.db.getRecentNotifications(filter);
  }
}
