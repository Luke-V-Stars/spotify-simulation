import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpotifyApiClient, SpotifyApiError } from '../public/js/spotify/apiClient.js';
import { fetchAssembledShelves, fetchLibrary, mapPlaylistEntry } from '../public/js/spotify/libraryService.js';
import { mapSdkState, playbackRequest } from '../public/js/spotify/playbackService.js';
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

test('uses the medium image on the shelf and the large one in the panel', () => {
  const track = mapPlaylistEntry({ item: rawTrack('x') });
  assert.equal(track.artThumbUrl, 'medium');
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

/** A song by a given artist, and a fake API covering every route the assembled shelves use. */
const songBy = (artistId, name) => ({ ...rawTrack(name), artists: [{ id: artistId, name: artistId }] });
const assembledRoutes = ({ liked = [], top = [], topArtists = [], searchResults = {} } = {}) => [
  ['/me/tracks', () => jsonResponse({ items: liked.map((track) => ({ track })), next: null })],
  ['/me/top/tracks', () => jsonResponse({ items: top })],
  ['/me/top/artists', () => jsonResponse({ items: topArtists })],
  ['/search', (url) => {
    const { searchParams } = new URL(url);
    const results = searchResults[searchParams.get('q')] ?? [];
    const offset = Number(searchParams.get('offset'));
    const hasMore = offset + 10 < results.length;
    return jsonResponse({ tracks: { items: results.slice(offset, offset + 10), next: hasMore ? 'more' : null } });
  }],
];
const names = (shelf) => shelf.tracks.map((track) => track.title);

test('Liked Songs follows pagination and has no playlist URI', async () => {
  const api = fakeApi([
    ['/me/tracks', (url) =>
      url.includes('offset=50')
        ? jsonResponse({ items: [{ track: rawTrack('2') }], next: null })
        : jsonResponse({ items: [{ track: rawTrack('1') }], next: 'https://api.spotify.com/v1/me/tracks?offset=50' })],
    ...assembledRoutes().slice(1),
  ]);
  const { shelves } = await fetchAssembledShelves(api, []);
  assert.equal(shelves[0].name, 'Liked Songs');
  assert.equal(shelves[0].uri, null);
  assert.deepEqual(names(shelves[0]), ['1', '2']);
});

test('Liked Songs keeps songs that are also in playlists, and songs that are in none', async () => {
  const inPlaylist = songBy('a', 'also in a playlist');
  const onlyLiked = songBy('a', 'only liked');
  const api = fakeApi(assembledRoutes({ liked: [inPlaylist, onlyLiked] }));
  const playlists = [{ tracks: [mapPlaylistEntry({ track: inPlaylist })] }];
  const { shelves } = await fetchAssembledShelves(api, playlists);
  assert.deepEqual(names(shelves[0]), ['also in a playlist', 'only liked']);
});

test('only Liked Songs keeps its shelf when it has no songs', async () => {
  const { shelves, needsReconnect, failed } = await fetchAssembledShelves(fakeApi(assembledRoutes()), []);
  assert.deepEqual(shelves.map((shelf) => shelf.name), ['Liked Songs']);
  assert.equal(needsReconnect, false);
  assert.equal(failed, 0);
});

test('suggestions skip songs the user has, other artists and repeated versions, and take turns', async () => {
  const topArtists = [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }];
  const api = fakeApi(
    assembledRoutes({
      liked: [songBy('a', 'liked')],
      top: [songBy('a', 'top')],
      topArtists,
      searchResults: {
        'artist:"a"': [songBy('a', 'liked'), songBy('a', 'a1'), songBy('other', 'stranger'), songBy('a', 'a1'), songBy('a', 'top'), songBy('a', 'a2')],
        'artist:"b"': [songBy('b', 'b1'), songBy('b', 'in playlist'), songBy('b', 'b2')],
      },
    }),
  );
  const playlists = [{ tracks: [mapPlaylistEntry({ track: songBy('b', 'in playlist') })] }];

  const { shelves } = await fetchAssembledShelves(api, playlists);
  const suggestions = shelves.find((shelf) => shelf.id === 'suggested');
  assert.equal(suggestions.name, 'Suggested For You');
  assert.deepEqual(new Set(names(suggestions)), new Set(['a1', 'a2', 'b1', 'b2']));
  assert.deepEqual(names(suggestions).slice(0, 2).sort(), ['a1', 'b1'], 'one from each artist before any seconds');
});

test('suggestions lead with new artists from the top artists\' most common genres', async () => {
  const topArtists = [
    { id: 'a', name: 'a', genres: ['country', 'rare'] },
    { id: 'b', name: 'b', genres: ['country'] },
  ];
  const api = fakeApi(
    assembledRoutes({
      topArtists,
      searchResults: {
        'genre:"country"': [songBy('new', 'new artist song'), songBy('a', 'top artist in genre')],
        'genre:"rare"': [songBy('newer', 'rare genre song')],
        'artist:"a"': [songBy('a', 'more by a')],
      },
    }),
  );
  const { shelves } = await fetchAssembledShelves(api, []);
  const suggested = names(shelves.find((shelf) => shelf.id === 'suggested'));
  assert.deepEqual(suggested.slice(0, 2), ['new artist song', 'rare genre song'], 'most common genre first, then the next');
  assert.ok(suggested.includes('more by a'));
  assert.ok(!suggested.includes('top artist in genre'), 'genre searches only add artists who are new');
});

test('suggestions stop at one full shelf, reading a second page of search results', async () => {
  const topArtists = Array.from({ length: 10 }, (_, i) => ({ id: `artist${i}`, name: `artist${i}` }));
  const searchResults = Object.fromEntries(
    topArtists.map(({ id }) => [`artist:"${id}"`, Array.from({ length: 20 }, (_, i) => songBy(id, `${id}-${i}`))]),
  );
  const api = fakeApi(assembledRoutes({ topArtists, searchResults }));
  const { shelves } = await fetchAssembledShelves(api, []);
  const suggestions = shelves.find((shelf) => shelf.id === 'suggested');
  assert.equal(suggestions.tracks.length, 50);
  assert.ok(names(suggestions).includes('artist0-4'));
});

test('a 403 asks to reconnect, other errors count as failures, and the remaining shelves still load', async () => {
  const forbidden = fakeApi([
    ['/me/tracks', () => jsonResponse({ error: { message: 'Insufficient client scope' } }, 403)],
    ...assembledRoutes({ top: [rawTrack('kept')] }).slice(1),
  ]);
  const reconnect = await fetchAssembledShelves(forbidden, []);
  assert.equal(reconnect.needsReconnect, true);
  assert.deepEqual(reconnect.shelves.map((shelf) => shelf.name), ['Liked Songs', 'Your Top Songs']);
  assert.equal(reconnect.shelves[0].status, 'reconnect', 'the Liked Songs shelf stays visible and says why it\'s empty');

  const broken = fakeApi([
    ['/me/tracks', () => jsonResponse({ error: { message: 'Not found' } }, 404)],
    ...assembledRoutes({ top: [rawTrack('kept')] }).slice(1),
  ]);
  const failure = await fetchAssembledShelves(broken, []);
  assert.equal(failure.needsReconnect, false);
  assert.equal(failure.failed, 1);
  assert.equal(failure.shelves[0].status, 'failed');
});

test('a session failure aborts instead of leaving out shelves', async () => {
  const api = new SpotifyApiClient(
    async () => {
      throw new Error('session ended');
    },
    { fetchImpl: async () => jsonResponse({}), sleep: noSleep },
  );
  await assert.rejects(fetchAssembledShelves(api, []), /session ended/);
});

test('a playlist plays as itself, and an assembled shelf as its own playable songs', () => {
  const track = { uri: 't1', isLocal: false };
  const other = { uri: 't2', isLocal: false };
  const local = { uri: 'local', isLocal: true };
  assert.deepEqual(playbackRequest(track, { uri: 'p' }, [track, other]), { context_uri: 'p', offset: { uri: 't1' } });
  assert.deepEqual(playbackRequest(track, { uri: null }, [local, track, other]), { uris: ['t1', 't2'], offset: { uri: 't1' } });
  assert.deepEqual(playbackRequest(track, null), { uris: ['t1'], offset: { uri: 't1' } });
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
