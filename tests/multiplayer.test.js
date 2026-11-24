import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { CLOSE_CODES, ROOM_SOCKET_PATH } from '../server/multiplayer.js';
import { cleanName, parseClientMessage, PLAYER_COLORS, randomRoomCode, ROOM_CODE_PATTERN, RoomRegistry } from '../server/rooms.js';
import { MatchCache } from '../server/youtubeMatches.js';
import { easePose, PoseThrottle } from '../public/js/multiplayer/presence.js';
import { createRoom, RoomClient } from '../public/js/multiplayer/roomClient.js';

// --- Messages and names -------------------------------------------------------------

test('display names are cleaned of control and formatting characters, and kept short', () => {
  assert.equal(cleanName('  Sam   Lee '), 'Sam Lee');
  assert.equal(cleanName('Sam\u0000‮Lee\n'), 'SamLee');
  assert.equal(cleanName('x'.repeat(40)), 'x'.repeat(24));
  assert.equal(cleanName('🎵'.repeat(30)), '🎵'.repeat(24), 'counts characters, not UTF-16 units');
  assert.equal(cleanName(''), 'Guest');
  assert.equal(cleanName('​'), 'Guest');
  assert.equal(cleanName(42), 'Guest');
});

test('room codes are six characters that are hard to misread', () => {
  for (let i = 0; i < 200; i++) assert.match(randomRoomCode(), ROOM_CODE_PATTERN);
  assert.doesNotMatch('ABC10O', ROOM_CODE_PATTERN);
});

test('join and move messages are read, and anything else is refused', () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'join', room: 'abcdef', name: 'Sam', x: 1.234, z: -2, yaw: 7 })), {
    type: 'join',
    room: 'ABCDEF',
    name: 'Sam',
    pose: { x: 1.23, z: -2, yaw: Math.round(Math.atan2(Math.sin(7), Math.cos(7)) * 100) / 100 },
  });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'join', room: 'ABCDEF' })).pose, null, 'a pose is optional when joining');
  assert.deepEqual(parseClientMessage('{"type":"move","x":0.5,"z":3,"yaw":-1}'), { type: 'move', pose: { x: 0.5, z: 3, yaw: -1 } });

  for (const text of [
    'not json',
    'null',
    '[]',
    '{"type":"shout"}',
    '{"type":"join","room":"AB"}',
    '{"type":"join","room":"ABCDE0"}',
    '{"type":"move","x":"1","z":0,"yaw":0}',
    '{"type":"move","x":1,"z":0}',
    '{"type":"move","x":1e9,"z":0,"yaw":0}',
    JSON.stringify({ type: 'move', x: 1, z: 0, yaw: 0, padding: 'x'.repeat(600) }),
  ]) {
    assert.equal(parseClientMessage(text), null, text.slice(0, 40));
  }
});

// --- Rooms ----------------------------------------------------------------------------

/** A registry whose timers are run by hand. */
function testRegistry(options = {}) {
  const timers = [];
  const registry = new RoomRegistry({
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
    ...options,
  });
  const runTimers = () => timers.filter((timer) => !timer.cleared).forEach((timer) => timer.callback());
  return { registry, runTimers };
}

/** A player connection that records what it's sent. */
const inbox = () => {
  const messages = [];
  const send = (message) => messages.push(message);
  return { messages, send, last: () => messages.at(-1) };
};

test('joining a room tells you who is there, and tells them about you', () => {
  const { registry } = testRegistry();
  const code = registry.create();
  assert.match(code, ROOM_CODE_PATTERN);

  const sam = inbox();
  const samJoin = registry.join(code, { name: 'Sam', pose: { x: 1, z: 2, yaw: 0 } }, sam.send);
  assert.equal(samJoin.ok, true);
  assert.deepEqual(sam.last(), { type: 'welcome', id: samJoin.player.id, room: code, players: [] });

  const alex = inbox();
  const alexJoin = registry.join(code, { name: 'Alex' }, alex.send);
  assert.deepEqual(alex.last().players, [{ id: samJoin.player.id, name: 'Sam', color: PLAYER_COLORS[0], x: 1, z: 2, yaw: 0 }]);
  assert.deepEqual(sam.last(), { type: 'joined', player: { id: alexJoin.player.id, name: 'Alex', color: PLAYER_COLORS[1] } });
  assert.equal(alex.messages.length, 1, 'you aren\'t told about yourself');
});

test('moves reach everyone else in the room, and leaving is announced', () => {
  const { registry } = testRegistry();
  const code = registry.create();
  const other = registry.create();
  const sam = inbox();
  const alex = inbox();
  const stranger = inbox();
  const { player: samPlayer } = registry.join(code, { name: 'Sam' }, sam.send);
  registry.join(code, { name: 'Alex' }, alex.send);
  registry.join(other, { name: 'Stranger' }, stranger.send);

  const samBefore = sam.messages.length;
  registry.move(samPlayer, { x: 3, z: 4, yaw: 1 });
  assert.deepEqual(alex.last(), { type: 'moved', id: samPlayer.id, x: 3, z: 4, yaw: 1 });
  assert.equal(sam.messages.length, samBefore, 'your own moves aren\'t echoed back');
  assert.equal(stranger.messages.length, 1, 'other rooms hear nothing');

  registry.leave(samPlayer);
  assert.deepEqual(alex.last(), { type: 'left', id: samPlayer.id });
  registry.move(samPlayer, { x: 9, z: 9, yaw: 0 });
  assert.equal(alex.last().type, 'left', 'a player who left can\'t move');
});

test('a full room, or one that doesn\'t exist, refuses to let you in', () => {
  const { registry } = testRegistry({ maxPlayersPerRoom: 2 });
  const code = registry.create();
  registry.join(code, { name: 'A' }, () => {});
  registry.join(code, { name: 'B' }, () => {});
  assert.deepEqual(registry.join(code, { name: 'C' }, () => {}), { ok: false, reason: 'full' });
  assert.deepEqual(registry.join('ZZZZZZ', { name: 'D' }, () => {}), { ok: false, reason: 'not_found' });
});

test('players get different colours, and a colour is reused once its player leaves', () => {
  const { registry } = testRegistry();
  const code = registry.create();
  const first = registry.join(code, { name: 'A' }, () => {}).player;
  const second = registry.join(code, { name: 'B' }, () => {}).player;
  assert.notEqual(first.color, second.color);
  registry.leave(first);
  assert.equal(registry.join(code, { name: 'C' }, () => {}).player.color, first.color);
});

test('an empty room closes after a while, unless someone comes back first', () => {
  const { registry, runTimers } = testRegistry();
  const unused = registry.create();
  const kept = registry.create();
  const player = registry.join(kept, { name: 'Host' }, () => {}).player;
  registry.leave(player);
  registry.join(kept, { name: 'Host again' }, () => {}); // a reload, say

  runTimers();
  assert.deepEqual(registry.join(unused, { name: 'Late' }, () => {}), { ok: false, reason: 'not_found' });
  assert.equal(registry.join(kept, { name: 'Friend' }, () => {}).ok, true);
  assert.equal(registry.roomCount, 1);
});

test('the server stops opening rooms at its limit', () => {
  const { registry } = testRegistry({ maxRooms: 2 });
  assert.ok(registry.create());
  assert.ok(registry.create());
  assert.equal(registry.create(), null);
});

// --- Over a real socket ---------------------------------------------------------------

const TEST_PORT = 18951;
const ORIGIN = `http://localhost:${TEST_PORT}`;
const SOCKET_URL = `ws://127.0.0.1:${TEST_PORT}${ROOM_SOCKET_PATH}`;
const config = loadConfig({ SPOTIFY_REDIRECT_URI: `http://127.0.0.1:${TEST_PORT}/auth/callback` });

let server;
before(async () => {
  server = createApp(config, fetch, { matchCache: new MatchCache({ filePath: null }) });
  await new Promise((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));
});
after(() => server.close());

/** A socket client that queues the messages it receives, for awaiting one at a time. */
function connect(origin = ORIGIN) {
  const ws = new WebSocket(SOCKET_URL, { origin });
  const queue = [];
  const waiting = [];
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  return {
    ws,
    closed,
    opened: new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    }),
    send: (message) => ws.send(typeof message === 'string' ? message : JSON.stringify(message)),
    next: () => (queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiting.push(resolve))),
  };
}

async function openRoom() {
  const response = await fetch(`http://127.0.0.1:${TEST_PORT}/rooms`, { method: 'POST' });
  assert.equal(response.status, 201);
  return (await response.json()).code;
}

test('two players in a room see each other join, move and leave', async () => {
  const code = await openRoom();
  const sam = connect();
  await sam.opened;
  sam.send({ type: 'join', room: code, name: 'Sam', x: 1, z: 1, yaw: 0 });
  const welcome = await sam.next();
  assert.equal(welcome.type, 'welcome');
  assert.deepEqual(welcome.players, []);

  const alex = connect();
  await alex.opened;
  alex.send({ type: 'join', room: code.toLowerCase(), name: 'Alex' });
  assert.equal((await alex.next()).players[0].name, 'Sam');
  const joined = await sam.next();
  assert.equal(joined.player.name, 'Alex');

  alex.send({ type: 'move', x: 2.5, z: -1, yaw: 0.5 });
  assert.deepEqual(await sam.next(), { type: 'moved', id: joined.player.id, x: 2.5, z: -1, yaw: 0.5 });

  alex.ws.close();
  assert.deepEqual(await sam.next(), { type: 'left', id: joined.player.id });
  sam.ws.close();
  await sam.closed;
});

test('sockets from other sites are refused before they connect', async () => {
  const intruder = connect('https://evil.example');
  await assert.rejects(intruder.opened, /403/);
  const missingOrigin = new WebSocket(SOCKET_URL);
  await assert.rejects(new Promise((resolve, reject) => {
    missingOrigin.on('open', resolve);
    missingOrigin.on('error', reject);
  }), /403/);
});

test('a bad first message, or a room that doesn\'t exist, ends the connection with a reason', async () => {
  const unknown = connect();
  await unknown.opened;
  unknown.send({ type: 'join', room: 'ZZZZZZ', name: 'Lost' });
  assert.equal(await unknown.closed, CLOSE_CODES.notFound);

  const rude = connect();
  await rude.opened;
  rude.send({ type: 'move', x: 0, z: 0, yaw: 0 });
  assert.equal(await rude.closed, CLOSE_CODES.badMessage);

  const garbled = connect();
  await garbled.opened;
  garbled.send('{{{');
  assert.equal(await garbled.closed, CLOSE_CODES.badMessage);
});

test('a client flooding the room is disconnected', async () => {
  const code = await openRoom();
  const flood = connect();
  await flood.opened;
  flood.send({ type: 'join', room: code, name: 'Flood' });
  await flood.next();
  for (let i = 0; i < 200; i++) flood.send({ type: 'move', x: i / 100, z: 0, yaw: 0 });
  assert.equal(await flood.closed, CLOSE_CODES.tooManyMessages);
});

// --- Browser side -----------------------------------------------------------------------

test('positions are sent at most 10 times a second, and only when they change', () => {
  const throttle = new PoseThrottle();
  assert.deepEqual(throttle.next({ x: 0, z: 0, yaw: 0 }, 0), { x: 0, z: 0, yaw: 0 });
  assert.equal(throttle.next({ x: 1, z: 0, yaw: 0 }, 50), null, 'too soon');
  assert.deepEqual(throttle.next({ x: 1, z: 0, yaw: 0 }, 100), { x: 1, z: 0, yaw: 0 });
  assert.equal(throttle.next({ x: 1.01, z: 0, yaw: 0.01 }, 500), null, 'too small a change');
  assert.deepEqual(throttle.next({ x: 1, z: 0, yaw: 0.5 }, 600), { x: 1, z: 0, yaw: 0.5 }, 'turning counts');
  throttle.reset();
  assert.ok(throttle.next({ x: 1, z: 0, yaw: 0.5 }, 601), 'after a reset the pose goes out again');
});

test('other players glide to where they are reported, turning the short way round', () => {
  const shown = { x: 0, z: 0, yaw: 3 };
  const target = { x: 2, z: -2, yaw: -3 };
  assert.equal(easePose(shown, target, 1 / 60), true);
  assert.ok(shown.x > 0 && shown.x < 2);
  assert.ok(shown.yaw > 3, 'from 3 to -3 radians is a short turn through π');
  for (let i = 0; i < 300; i++) easePose(shown, target, 1 / 60);
  assert.equal(easePose(shown, target, 1 / 60), false);
  assert.deepEqual(shown, target);
});

/** A stand-in for the browser's WebSocket. */
class FakeSocket {
  static OPEN = 1;
  static instances = [];
  readyState = 0;
  sent = [];
  #listeners = {};
  constructor(url) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  addEventListener(type, callback) {
    (this.#listeners[type] ??= []).push(callback);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {}
  fire(type, event = {}) {
    if (type === 'open') this.readyState = FakeSocket.OPEN;
    for (const callback of this.#listeners[type] ?? []) callback(event);
  }
}

function testClient() {
  FakeSocket.instances = [];
  const timers = [];
  const client = new RoomClient({
    code: 'ABCDEF',
    name: 'Sam',
    getPose: () => ({ x: 1, z: 2, yaw: 0 }),
    url: 'ws://test/rooms/socket',
    WebSocketImpl: FakeSocket,
    setTimer: (callback, ms) => timers.push({ callback, ms }),
  });
  const statuses = [];
  client.on('status', (status) => statuses.push(status));
  return { client, timers, statuses, socket: () => FakeSocket.instances.at(-1) };
}

test('the room client joins with its position, and passes on what the server says', () => {
  const { client, statuses, socket } = testClient();
  const welcomes = [];
  const moves = [];
  client.on('welcome', (message) => welcomes.push(message));
  client.on('moved', (message) => moves.push(message));
  client.connect();
  client.sendPose({ x: 0, z: 0, yaw: 0 }); // not open yet: dropped, not thrown
  socket().fire('open');
  assert.deepEqual(socket().sent, [{ type: 'join', room: 'ABCDEF', name: 'Sam', x: 1, z: 2, yaw: 0 }]);

  socket().fire('message', { data: JSON.stringify({ type: 'welcome', id: 'p1', players: [] }) });
  socket().fire('message', { data: JSON.stringify({ type: 'moved', id: 'p2', x: 1, z: 1, yaw: 1 }) });
  socket().fire('message', { data: 'garbage' });
  assert.equal(welcomes.length, 1);
  assert.equal(moves[0].id, 'p2');
  assert.deepEqual(statuses, [{ state: 'connected' }]);
});

test('the room client reconnects after a dropped connection, but not after a refusal', () => {
  const { client, timers, statuses, socket } = testClient();
  client.connect();
  socket().fire('open');
  socket().fire('close', { code: 1006 });
  assert.deepEqual(statuses.at(-1), { state: 'reconnecting' });
  assert.equal(timers[0].ms, 1000);
  timers[0].callback();
  assert.equal(FakeSocket.instances.length, 2, 'a new socket was opened');

  socket().fire('close', { code: 1006 });
  assert.equal(timers[1].ms, 2000, 'waits longer each time');

  timers[1].callback();
  socket().fire('close', { code: 4404 });
  assert.equal(statuses.at(-1).state, 'closed');
  assert.match(statuses.at(-1).message, /closed, or the link is wrong/);
  assert.equal(timers.length, 2, 'no retry after the room refused');
});

test('leaving on purpose doesn\'t reconnect', () => {
  const { client, timers, statuses, socket } = testClient();
  client.connect();
  socket().fire('open');
  client.close();
  socket().fire('close', { code: 1000 });
  assert.equal(timers.length, 0);
  assert.deepEqual(statuses, []);
});

test('opening a room reports the server\'s reason when it can\'t', async () => {
  const full = async () => new Response(JSON.stringify({ error: 'Too many rooms are open right now.' }), { status: 503 });
  await assert.rejects(createRoom(full), /Too many rooms/);
  const ok = async () => new Response(JSON.stringify({ code: 'ABCDEF' }), { status: 201 });
  assert.equal(await createRoom(ok), 'ABCDEF');
});
