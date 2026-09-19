import path from 'path';
import App from './app';

import { MongoDB } from './db/mongo.db';
import { PORT, HOST, STAGE, ENV } from './env';
import { DB_CONN_STR as dbURL } from './env';
import AuthController from './controllers/auth.controller';
import AccountController from './controllers/account.controller';
import MapController from './controllers/map.controller';
import BusController from './controllers/transit.controller';
import HealthController from './controllers/health.controller';
import NotificationController from './controllers/notification.controller';
import SubscriptionsController from './controllers/subscriptions.controller';

const app = new App(
  [
    AuthController.getInstance('/auth'),
    AccountController.getInstance('/account'),
    MapController.getInstance('/'),
    BusController.getInstance('/transit'),
    HealthController.getInstance('/transit'),
    NotificationController.getInstance('/notifications'),
    SubscriptionsController.getInstance('/subscriptions')
  ],
  {
    clientDir: path.join(__dirname, '../.dist/client'),
    db: new MongoDB(dbURL),
    port: PORT,
    host: HOST,
    url: `${HOST}${ENV === 'LOCAL' ? ':' + PORT.toString() : ''}`,
    initOnStart: STAGE !== 'PROD' && process.env.ALLOW_DB_RESET === 'true'
  }
);

app.listen();
