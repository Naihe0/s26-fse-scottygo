// Live notification rules: route subscriptions, bus condition reports, and
// the rider notifications published when a bus's reported condition changes.

import DAC from '../db/dac';
import { randomUUID as uuidV4 } from 'node:crypto';
import {
  ISubscription,
  IBusReport,
  INotification,
  ILastKnownBusStatus,
  ICrowdedness,
  IPrioritySeating,
  IBusCondition,
  CROWDEDNESS_LEVELS,
  PRIORITY_SEATING_STATES,
  BUS_CONDITIONS
} from '../../common/transit.interface';
import { haversineMeters, METERS_PER_MILE } from '../../common/geo';
import {
  MAX_IDENTIFIER_LENGTH,
  MAX_REPORT_COMMENT_LENGTH
} from '../../common/limits';
import { clientError } from '../errors';
import moderationService from '../services/moderation.service';
import notificationSourcesService from '../services/notification-sources.service';
import { isValidCoordinate } from '../services/transit-validation';

/** A rider must be this close to the bus to report on it. */
const PROXIMITY_LIMIT_MILES = 0.5;

/** Report condition fields and the values each accepts. */
const CONDITION_FIELDS = {
  crowdedness: CROWDEDNESS_LEVELS,
  prioritySeating: PRIORITY_SEATING_STATES,
  condition: BUS_CONDITIONS
} as const satisfies Record<keyof ILastKnownBusStatus, readonly string[]>;

const CONDITION_LABELS: Record<keyof ILastKnownBusStatus, string> = {
  crowdedness: 'Crowdedness',
  prioritySeating: 'Priority seating',
  condition: 'Condition'
};

type ConditionField = keyof typeof CONDITION_FIELDS;

const CONDITION_FIELD_NAMES = Object.keys(CONDITION_FIELDS) as ConditionField[];

type ISubmitReportData = {
  vid: string;
  routeId: string;
  crowdedness?: string;
  prioritySeating?: string;
  condition?: string;
  comment?: string;
  lat: number;
  lon: number;
  /** Set by the server for administrators, never by clients. */
  bypassProximityCheck?: boolean;
};

type ModerationOutcome = {
  commentFlagged: boolean;
  commentFlagCategory?: 'inappropriate' | 'irrelevant';
  /** The comment to publish, absent when empty or flagged. */
  publishedComment?: string;
};

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= MAX_IDENTIFIER_LENGTH;

function validateReportData(data: ISubmitReportData): void {
  if (!data.vid || !data.routeId || data.lat == null || data.lon == null) {
    throw clientError(
      'MissingParameter',
      'vid, routeId, lat, and lon are required.'
    );
  }
  if (
    !isIdentifier(data.vid) ||
    !isIdentifier(data.routeId) ||
    !isValidCoordinate(data.lat, data.lon) ||
    (data.comment !== undefined &&
      (typeof data.comment !== 'string' ||
        data.comment.length > MAX_REPORT_COMMENT_LENGTH))
  ) {
    throw clientError(
      'InvalidReportField',
      'Use valid route/bus IDs, numeric coordinates, and a comment of at most 200 characters.'
    );
  }
  if (
    CONDITION_FIELD_NAMES.every((field) => !data[field]) &&
    !data.comment?.trim()
  ) {
    throw clientError(
      'EmptyReport',
      'Please answer at least one question to submit a report.'
    );
  }
  for (const field of CONDITION_FIELD_NAMES) {
    const value = data[field];
    const allowed: readonly string[] = CONDITION_FIELDS[field];
    if (value !== undefined && value !== '' && !allowed.includes(value)) {
      throw clientError(
        'InvalidReportField',
        `Invalid ${field} value. Must be one of: ${allowed.join(', ')}`
      );
    }
  }
}

async function enforceProximityRule(data: ISubmitReportData): Promise<void> {
  const wanted = data.vid.trim().toLowerCase();
  const vehicles = await notificationSourcesService.getVehiclesForRoute(
    data.routeId
  );
  const bus = vehicles.find((v) => v.vid.trim().toLowerCase() === wanted);
  if (!bus) {
    throw clientError(
      'VehicleNotFound',
      `Vehicle ${data.vid} not found on route ${data.routeId}.`
    );
  }
  const distanceMiles =
    haversineMeters(
      { lat: data.lat, lng: data.lon },
      { lat: bus.lat, lng: bus.lon }
    ) / METERS_PER_MILE;
  if (!data.bypassProximityCheck && distanceMiles > PROXIMITY_LIMIT_MILES) {
    throw clientError(
      'ProximityViolation',
      'You need to be near this bus to submit a report.'
    );
  }
}

async function moderateComment(
  comment: string | undefined
): Promise<ModerationOutcome> {
  if (!comment) return { commentFlagged: false };
  const result = await moderationService.moderate(comment);
  return result.flagged
    ? { commentFlagged: true, commentFlagCategory: result.category }
    : { commentFlagged: false, publishedComment: comment };
}

export class NotificationModel {
  /**
   * Last reported conditions per vehicle, used to publish only changes.
   * Kept in memory: after a restart the next report for a bus publishes.
   */
  private static lastKnownStatus = new Map<string, ILastKnownBusStatus>();

  // ── Subscriptions ──────────────────────────────────────────────────

  static async getSubscriptions(userId: string): Promise<ISubscription[]> {
    return DAC.db.getSubscriptionsByUserId(userId);
  }

  /** Save a route; uniqueness and the per-user limit are enforced by the DB. */
  static async subscribe(
    userId: string,
    routeId: string
  ): Promise<ISubscription> {
    const routeIds = await notificationSourcesService.getSubscribableRouteIds();
    if (!routeIds.has(routeId)) {
      throw clientError('RouteNotFound', `Route ${routeId} does not exist.`);
    }
    return DAC.db.saveSubscription({
      _id: uuidV4(),
      userId,
      routeId,
      createdAt: new Date().toISOString()
    });
  }

  static async unsubscribe(userId: string, routeId: string): Promise<void> {
    if (!(await DAC.db.deleteSubscription(userId, routeId))) {
      throw clientError(
        'SubscriptionNotFound',
        `You are not subscribed to Route ${routeId}.`
      );
    }
  }

  // ── Bus reports ────────────────────────────────────────────────────

  /**
   * Validate and store a bus report. A notification is created only when a
   * condition differs from the bus's last reported value.
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
    validateReportData(data);
    await enforceProximityRule(data);
    const { commentFlagged, commentFlagCategory, publishedComment } =
      await moderateComment(data.comment);

    const report = await DAC.db.saveBusReport({
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
    });

    const lastStatus = NotificationModel.lastKnownStatus.get(data.vid) ?? {};
    const changedFields = CONDITION_FIELD_NAMES.filter(
      (field) => data[field] && data[field] !== lastStatus[field]
    );
    if (changedFields.length === 0) {
      return { report, notification: null, commentFlagged, commentFlagCategory };
    }

    const notification = await DAC.db.saveNotification({
      _id: uuidV4(),
      routeId: data.routeId,
      vid: data.vid,
      message: NotificationModel.buildMessage(
        data,
        changedFields,
        publishedComment
      ),
      changedFields,
      reportId: report._id!,
      createdAt: new Date().toISOString()
    });

    // Update only after the notification is saved, so a failed save can be
    // retried by the next identical report.
    const updatedStatus: ILastKnownBusStatus = { ...lastStatus };
    for (const field of changedFields) {
      Object.assign(updatedStatus, { [field]: data[field] });
    }
    NotificationModel.lastKnownStatus.set(data.vid, updatedStatus);

    return { report, notification, commentFlagged, commentFlagCategory };
  }

  private static buildMessage(
    data: ISubmitReportData,
    changedFields: ConditionField[],
    comment?: string
  ): string {
    const parts = changedFields.map(
      (field) => `${CONDITION_LABELS[field]} changed to ${data[field]}`
    );
    if (comment) parts.push(`Comment: "${comment}"`);
    return `Bus #${data.vid} on Route ${data.routeId} — ${parts.join(', ')}`;
  }

  // ── Notifications ──────────────────────────────────────────────────

  /**
   * Recent notifications, optionally limited to a route and/or bus, and
   * filtered by case-insensitive message text.
   */
  static async searchNotifications(params: {
    route?: string;
    bus?: string;
    q?: string;
  }): Promise<INotification[]> {
    const filter: Record<string, unknown> = {};
    if (params.route) filter.routeId = params.route;
    if (params.bus) filter.vid = params.bus;

    const notifications = await DAC.db.getRecentNotifications(filter);
    if (!params.q) return notifications;
    const query = params.q.toLowerCase();
    return notifications.filter((n) =>
      n.message.toLowerCase().includes(query)
    );
  }
}
