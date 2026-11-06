import { createServer } from 'node:http';
import { Server } from 'socket.io';

/** The browser uses its normal Socket.IO handshake and room subscriptions. */
export async function socketFixture() {
  const http = createServer();
  const socket = new Server(http, { serveClient: false });
  const roomWatchers = new Set();
  const checkRooms = () => roomWatchers.forEach((check) => check());
  socket.on('connection', (client) => {
    client.on('subscribeRoute', ({ routeId }) => {
      client.join(routeId);
      checkRooms();
    });
    client.on('unsubscribeRoute', ({ routeId }) => {
      client.leave(routeId);
      checkRooms();
    });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + http.address().port;
  return {
    origin: base,
    waitForSubscribers(routeId, count) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if ((socket.sockets.adapter.rooms.get(routeId)?.size ?? 0) < count)
            return;
          clearTimeout(timer);
          roomWatchers.delete(check);
          resolve();
        };
        const timer = setTimeout(() => {
          roomWatchers.delete(check);
          reject(
            new Error(`Expected ${count} socket subscribers for ${routeId}`)
          );
        }, 6500);
        roomWatchers.add(check);
        check();
      });
    },
    notify() {
      socket.to('61C').emit('liveNotification', {
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
