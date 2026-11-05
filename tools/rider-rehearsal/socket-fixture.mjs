import { createServer } from 'node:http';
import { Server } from 'socket.io';

/** The browser uses its normal Socket.IO handshake and room subscriptions. */
export async function socketFixture() {
  const http = createServer();
  const socket = new Server(http, { serveClient: false });
  socket.on('connection', (client) => {
    client.on('subscribeRoute', ({ routeId }) => client.join(routeId));
    client.on('unsubscribeRoute', ({ routeId }) => client.leave(routeId));
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + http.address().port;
  return {
    origin: base,
    notify() {
      socket
        .to('61C')
        .emit('liveNotification', {
          _id: 'fixture-alert',
          routeId: '61C',
          vid: '4100',
          reportId: 'r1',
          message: 'Bus 4100 has standing room.',
          changedFields: ['crowdedness'],
          createdAt: new Date().toISOString()
        });
    },
    close: () => new Promise((resolve) => socket.close(resolve))
  };
}
