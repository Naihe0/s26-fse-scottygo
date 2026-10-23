// Subscriptions, bus reports, rider notifications, and service alerts.
// Base path: /notifications

import { Request, Response } from 'express';
import Controller, { type AuthenticatedRequest } from './controller';
import { NotificationModel } from '../models/notification.model';
import { User } from '../models/user.model';
import alertsService from '../services/alerts.service';
import { serverError } from '../errors';

/** Trimmed query string value, or undefined when absent or blank. */
function queryText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export default class NotificationController extends Controller {
  private static instance: NotificationController | null = null;

  private constructor(path: string) {
    super(path);
  }

  public static getInstance(path: string): NotificationController {
    if (!NotificationController.instance) {
      NotificationController.instance = new NotificationController(path);
    }
    return NotificationController.instance;
  }

  public initializeRoutes(): void {
    // The page itself is public; the browser handles sign-in.
    this.router.get('/', (_req, res) =>
      this.sendPage(res, 'notifications.html')
    );

    this.router.use(this.authenticateToken.bind(this));
    this.router.get('/subscriptions', this.getSubscriptions.bind(this));
    this.router.post('/subscriptions', this.subscribe.bind(this));
    this.router.delete('/subscriptions/:routeId', this.unsubscribe.bind(this));
    this.router.post('/reports', this.submitReport.bind(this));
    this.router.get('/notifications', this.searchNotifications.bind(this));
    this.router.get('/alerts', this.getAlerts.bind(this));
  }

  private async getSubscriptions(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = (req as AuthenticatedRequest).user;
      const subscriptions = await NotificationModel.getSubscriptions(userId);
      res
        .status(200)
        .json(
          this.success(
            'SubscriptionsRetrieved',
            subscriptions,
            `Found ${subscriptions.length} subscriptions`
          )
        );
    } catch (error) {
      this.handleAppError(res, error, undefined, 'GetRequestFailure');
    }
  }

  private async subscribe(req: Request, res: Response): Promise<void> {
    const { routeId } = req.body;
    if (!routeId) {
      this.sendClientError(res, 400, 'MissingParameter', 'routeId is required');
      return;
    }
    try {
      const { userId } = (req as AuthenticatedRequest).user;
      const subscription = await NotificationModel.subscribe(userId, routeId);
      res
        .status(201)
        .json(
          this.success(
            'RouteSubscribed',
            subscription,
            `Subscribed to route ${routeId}`
          )
        );
    } catch (error) {
      this.handleAppError(res, error, undefined, 'PostRequestFailure');
    }
  }

  private async unsubscribe(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = (req as AuthenticatedRequest).user;
      const { routeId } = req.params;
      await NotificationModel.unsubscribe(userId, routeId);
      res
        .status(200)
        .json(
          this.success(
            'RouteUnsubscribed',
            null,
            `Unsubscribed from route ${routeId}`
          )
        );
    } catch (error) {
      this.handleAppError(res, error, undefined, 'PostRequestFailure');
    }
  }

  private async submitReport(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = (req as AuthenticatedRequest).user;
      const {
        vid,
        routeId,
        crowdedness,
        prioritySeating,
        condition,
        comment,
        lat,
        lon
      } = req.body;
      // Administrators are exempt from the proximity rule; clients cannot
      // request the exemption themselves.
      const requester = await User.getUserAccountById(userId);
      const result = await NotificationModel.submitReport(userId, {
        vid,
        routeId,
        crowdedness,
        prioritySeating,
        condition,
        comment,
        lat,
        lon,
        bypassProximityCheck: requester.privilegeLevel === 'Administrator'
      });

      if (result.notification) {
        Controller.io
          .to(`route:${routeId}`)
          .emit('liveNotification', result.notification);
      }

      const message = !result.commentFlagged
        ? 'Report submitted. Thank you!'
        : result.commentFlagCategory === 'irrelevant'
          ? 'Your comment was not included because it appears unrelated to bus service.'
          : 'Your comment was flagged and will not be included in the notification.';
      res
        .status(201)
        .json(this.success('ReportSubmitted', result.report, message));
    } catch (error) {
      this.handleAppError(res, error, undefined, 'ReportSubmissionFailure');
    }
  }

  // GET /notifications/notifications?route=&bus=&q=
  private async searchNotifications(
    req: Request,
    res: Response
  ): Promise<void> {
    try {
      const notifications = await NotificationModel.searchNotifications({
        route: queryText(req.query.route),
        bus: queryText(req.query.bus),
        q: queryText(req.query.q)
      });
      res
        .status(200)
        .json(
          this.success(
            'NotificationsRetrieved',
            notifications,
            `Found ${notifications.length} notifications`
          )
        );
    } catch (error) {
      this.handleAppError(res, error, undefined, 'GetRequestFailure');
    }
  }

  private getAlerts(_req: Request, res: Response): void {
    if (!alertsService.isHealthy()) {
      res
        .status(503)
        .json(
          serverError(
            'AlertFeedUnavailable',
            'Service alerts are temporarily unavailable.'
          )
        );
      return;
    }
    const alerts = alertsService.getAlerts();
    res
      .status(200)
      .json(
        this.success(
          'AlertsRetrieved',
          alerts,
          `Found ${alerts.length} service alerts`
        )
      );
  }
}
