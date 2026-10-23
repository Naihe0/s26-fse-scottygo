// Subscriptions page. The subscription API lives under /notifications.

import Controller from './controller';

export default class SubscriptionsController extends Controller {
  private static instance: SubscriptionsController | null = null;

  private constructor(path: string) {
    super(path);
  }

  public static getInstance(path: string): SubscriptionsController {
    if (!SubscriptionsController.instance) {
      SubscriptionsController.instance = new SubscriptionsController(path);
    }
    return SubscriptionsController.instance;
  }

  public initializeRoutes(): void {
    this.router.get('/', (_req, res) =>
      this.sendPage(res, 'subscriptions.html')
    );
  }
}
