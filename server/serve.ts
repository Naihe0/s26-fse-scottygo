// Server entry point: wire controllers and the database into the app.

import path from 'path';
import App from './app';
import { MongoDB } from './db/mongo.db';
import { PORT, HOST, STAGE, ENV, DB_CONN_STR } from './env';
import AuthController from './controllers/auth.controller';
import AccountController from './controllers/account.controller';
import MapController from './controllers/map.controller';
import TransitController from './controllers/transit.controller';
import HealthController from './controllers/health.controller';
import NotificationController from './controllers/notification.controller';
import SubscriptionsController from './controllers/subscriptions.controller';

const app = new App(
  [
    AuthController.getInstance('/auth'),
    AccountController.getInstance('/account'),
    MapController.getInstance('/'),
    TransitController.getInstance('/transit'),
    HealthController.getInstance('/transit'),
    NotificationController.getInstance('/notifications'),
    SubscriptionsController.getInstance('/subscriptions')
  ],
  {
    clientDir: path.join(__dirname, '../.dist/client'),
    db: new MongoDB(DB_CONN_STR),
    port: PORT,
    host: HOST,
    url: `${HOST}${ENV === 'LOCAL' ? `:${PORT}` : ''}`,
    initOnStart: STAGE !== 'PROD' && process.env.ALLOW_DB_RESET === 'true'
  }
);

app.listen();
