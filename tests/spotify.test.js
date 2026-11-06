import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpotifyApiClient, SpotifyApiError } from '../public/js/spotify/apiClient.js';
import { fetchLibrary, mapPlaylistEntry } from '../public/js/spotify/libraryService.js';
import { mapSdkState } from '../public/js/spotify/playbackService.js';
import { formatDuration, formatReleaseDate } from '../public/js/ui/format.js';

const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers });

const noSleep = () => Promise.resolve();

/** Routes fake API calls by URL substring. Each handler gets the URL and returns a Response. */
function fakeApi(routes, tokenLog = []) {
  const fetchImpl = async (url, options) => {
    for (const [pattern, handler] of routes) {
      if (url.includes(pattern)) return handler(url, options);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const getToken = async ({ forceRefresh } = {}) => {
    tokenLog.push(Boolean(forceRefresh));
    return 'token';
  };
  return new SpotifyApiClient(getToken, { fetchImpl, sleep: noSleep });
}

const rawTrack = (name) => ({
  type: 'track',
  uri: `spotify:track:${name}`,
  name,
  duration_ms: 1000,
  artists: [{ name: 'A' }],
  album: {
    name: 'Album',
    release_date: '1999-03',
    release_date_precision: 'month',
    images: [
      { url: 'large', width: 640, height: 640 },
      { url: 'medium', width: 300, height: 300 },
      { url: 'small', width: 64, height: 64 },
    ],
  },
});

test('reads the current `item` field and the older `track` field', () => {
  assert.equal(mapPlaylistEntry({ item: rawTrack('new') }).title, 'new');
  assert.equal(mapPlaylistEntry({ track: rawTrack('old') }).title, 'old');
});

test('skips episodes and empty entries', () => {
  assert.equal(mapPlaylistEntry({ item: { type: 'episode' } }), null);
  assert.equal(mapPlaylistEntry({ item: null }), null);
  assert.equal(mapPlaylistEntry(null), null);
});

test('uses the small image on the shelf and the large one in the panel', () => {
  const track = mapPlaylistEntry({ item: rawTrack('x') });
  assert.equal(track.artThumbUrl, 'small');
  assert.equal(track.artFullUrl, 'large');
});

test('tolerates songs with no artwork', () => {
  const raw = rawTrack('x');
  raw.album.images = [];
  assert.equal(mapPlaylistEntry({ item: raw }).artThumbUrl, null);
});

test('fetchLibrary follows pagination for playlists and for songs', async () => {
  const api = fakeApi([
    ['/me/playlists', (url) =>
      url.includes('offset=50')
        ? jsonResponse({ items: [{ id: 'b', name: 'B' }], next: null })
        : jsonResponse({
            items: [{ id: 'a', name: 'A' }, null],
            next: 'https://api.spotify.com/v1/me/playlists?offset=50',
          })],
    ['/playlists/a/items', (url) =>
      url.includes('offset=50')
        ? jsonResponse({ items: [{ item: rawTrack('2') }], next: null })
        : jsonResponse({
            items: [{ item: rawTrack('1') }],
            next: 'https://api.spotify.com/v1/playlists/a/items?offset=50',
          })],
    ['/playlists/b/items', () => jsonResponse({ items: [], next: null })],
  ]);

  const progress = [];
  const playlists = await fetchLibrary(api, (loaded, total) => progress.push([loaded, total]));

  assert.deepEqual(playlists.map((playlist) => playlist.id), ['a', 'b']);
  assert.deepEqual(playlists[0].tracks.map((track) => track.title), ['1', '2']);
  assert.deepEqual(progress.at(-1), [2, 2]);
});

test('a 403 marks only that playlist as restricted, and other errors as failed', async () => {
  const api = fakeApi([
    ['/me/playlists', () =>
      jsonResponse({ items: [{ id: 'mine' }, { id: 'followed' }, { id: 'broken' }], next: null })],
    ['/playlists/mine/items', () => jsonResponse({ items: [{ item: rawTrack('1') }], next: null })],
    ['/playlists/followed/items', () => jsonResponse({ error: { message: 'Forbidden' } }, 403)],
    ['/playlists/broken/items', () => jsonResponse({ error: { message: 'Not found' } }, 404)],
  ]);

  const [mine, followed, broken] = await fetchLibrary(api);
  assert.equal(mine.status, 'ok');
  assert.equal(mine.tracks.length, 1);
  assert.equal(followed.status, 'restricted');
  assert.equal(broken.status, 'failed');
});

test('a session failure during song loading aborts instead of showing empty shelves', async () => {
  const fetchImpl = async (url) =>
    url.includes('/me/playlists') ? jsonResponse({ items: [{ id: 'a' }], next: null }) : jsonResponse({}, 200);
  let calls = 0;
  const getToken = async () => {
    if (++calls > 1) throw new Error('session ended');
    return 'token';
  };
  const api = new SpotifyApiClient(getToken, { fetchImpl, sleep: noSleep });
  await assert.rejects(fetchLibrary(api), /session ended/);
});

test('retries after a 429, waiting for Retry-After', async () => {
  const waits = [];
  let attempts = 0;
  const api = new SpotifyApiClient(async () => 'token', {
    sleep: async (ms) => waits.push(ms),
    fetchImpl: async () =>
      ++attempts === 1 ? jsonResponse(null, 429, { 'Retry-After': '3' }) : jsonResponse({ ok: true }),
  });
  assert.deepEqual(await api.get('/me'), { ok: true });
  assert.deepEqual(waits, [3000]);
});

test('a 401 forces a token refresh and retries', async () => {
  const tokenLog = [];
  let attempts = 0;
  const api = fakeApi([['/me', () => (++attempts === 1 ? jsonResponse(null, 401) : jsonResponse({ ok: true }))]], tokenLog);
  assert.deepEqual(await api.get('/me'), { ok: true });
  assert.deepEqual(tokenLog, [false, true]);
});

test('retries 5xx responses, then gives up with the status', async () => {
  let attempts = 0;
  const api = fakeApi([['/me', () => (attempts++, jsonResponse({ error: { message: 'down' } }, 503))]]);
  await assert.rejects(api.get('/me'), (error) => error instanceof SpotifyApiError && error.status === 503);
  assert.equal(attempts, 4);
});

test('does not retry other client errors', async () => {
  let attempts = 0;
  const api = fakeApi([['/me', () => (attempts++, jsonResponse({ error: { message: 'nope' } }, 404))]]);
  await assert.rejects(api.get('/me'), /nope/);
  assert.equal(attempts, 1);
});

test('empty player responses resolve to null', async () => {
  const api = fakeApi([['/me/player/play', () => jsonResponse(null, 204)]]);
  assert.equal(await api.put('/me/player/play', { uris: [] }), null);
});

test('maps SDK state, keeping the original URI of relinked tracks', () => {
  const state = mapSdkState({
    paused: true,
    context: { uri: 'spotify:playlist:p' },
    track_window: {
      current_track: {
        uri: 'spotify:track:relinked',
        linked_from: { uri: 'spotify:track:original' },
        name: 'Song',
        artists: [{ name: 'A' }, { name: 'B' }],
        album: { images: [{ url: 'big' }, { url: 'small' }] },
      },
    },
  });
  assert.deepEqual(state.uris, ['spotify:track:relinked', 'spotify:track:original']);
  assert.equal(state.artist, 'A, B');
  assert.equal(state.paused, true);
  assert.equal(state.contextUri, 'spotify:playlist:p');
});

test('null SDK state (playback moved elsewhere) maps to null', () => {
  assert.equal(mapSdkState(null), null);
});

test('formats durations', () => {
  assert.equal(formatDuration(215000), '3:35');
  assert.equal(formatDuration(5000), '0:05');
  assert.equal(formatDuration(3725000), '1:02:05');
});

test('formats release dates at each precision without timezone drift', () => {
  assert.equal(formatReleaseDate('1981', 'year'), '1981');
  assert.match(formatReleaseDate('1981-12', 'month'), /1981/);
  assert.match(formatReleaseDate('1981-01-01', 'day'), /1981/);
  assert.equal(formatReleaseDate(null), 'Unknown');
});
