/**
 * The live connection for shared rooms: a WebSocket at /rooms/socket, plus POST /rooms
 * to open a room. Room logic lives in rooms.js; this file handles sockets and abuse.
 *
 * Nothing secret travels over this connection. Players are known only by a display
 * name and a random id, and no cookies or Spotify tokens are read here.
 */

import { WebSocketServer } from 'ws';
import { parseClientMessage } from './rooms.js';

export const ROOM_SOCKET_PATH = '/rooms/socket';

/** WebSocket close codes the browser uses to explain what happened. */
export const CLOSE_CODES = {
  badMessage: 4400,
  wrongOrigin: 4403,
  notFound: 4404,
  joinTimeout: 4408,
  full: 4409,
  tooManyMessages: 4429,
};

const MAX_PAYLOAD_BYTES = 1024;
const JOIN_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
/** Clients send at most 10 moves a second. Extras are dropped, and a flood ends the connection. */
const MESSAGES_PER_SECOND = 30;
const FLOOD_PER_SECOND = 120;
/** A client this far behind on reading isn't sent more moves until it catches up. */
const MAX_BUFFERED_BYTES = 256 * 1024;

/** Counts messages per one-second window. */
function rateLimiter(now = Date.now) {
  let windowStart = now();
  let count = 0;
  return () => {
    if (now() - windowStart >= 1000) {
      windowStart = now();
      count = 0;
    }
    count++;
    if (count > FLOOD_PER_SECOND) return 'flood';
    return count > MESSAGES_PER_SECOND ? 'drop' : 'ok';
  };
}

/**
 * @param {import('node:http').Server} server
 * @param {{appOrigin: string}} config
 * @param {import('./rooms.js').RoomRegistry} rooms
 */
export function attachMultiplayer(server, config, rooms) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      ({ pathname } = new URL(req.url, 'http://internal'));
    } catch {
      pathname = null;
    }
    // Browsers always send Origin on WebSockets. Checking it stops other sites' pages
    // from connecting on a visitor's behalf.
    const status = pathname !== ROOM_SOCKET_PATH ? '404 Not Found' : req.headers.origin !== config.appOrigin ? '403 Forbidden' : null;
    if (status) {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, rooms));
  });

  // Connections that vanish without closing, such as a laptop going to sleep, are found
  // by pinging, so they don't sit in a room forever.
  const heartbeat = setInterval(() => {
    for (const ws of sockets.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  server.on('close', () => {
    clearInterval(heartbeat);
    for (const ws of sockets.clients) ws.terminate();
  });
}

function handleConnection(ws, rooms) {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  let player = null;
  const allow = rateLimiter();
  const joinTimer = setTimeout(() => ws.close(CLOSE_CODES.joinTimeout, 'join timeout'), JOIN_TIMEOUT_MS);

  const send = (message) => {
    if (ws.readyState !== ws.OPEN) return;
    if (message.type === 'moved' && ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
    ws.send(JSON.stringify(message));
  };

  ws.on('message', (data, isBinary) => {
    const verdict = allow();
    if (verdict === 'flood') return ws.close(CLOSE_CODES.tooManyMessages, 'too many messages');
    if (verdict === 'drop') return undefined;

    const message = isBinary ? null : parseClientMessage(data.toString());
    if (!message) return ws.close(CLOSE_CODES.badMessage, 'bad message');

    if (!player) {
      if (message.type !== 'join') return ws.close(CLOSE_CODES.badMessage, 'join first');
      const result = rooms.join(message.room, { name: message.name, pose: message.pose }, send);
      if (!result.ok) return ws.close(result.reason === 'full' ? CLOSE_CODES.full : CLOSE_CODES.notFound, result.reason);
      player = result.player;
      clearTimeout(joinTimer);
    } else if (message.type === 'move') {
      rooms.move(player, message.pose);
    }
    return undefined;
  });

  ws.on('close', () => {
    clearTimeout(joinTimer);
    if (player) rooms.leave(player);
  });
  ws.on('error', () => {}); // 'close' always follows, and cleans up
}
