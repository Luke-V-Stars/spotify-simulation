import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PlaybackSwitch, SPOTIFY, YOUTUBE } from '../public/js/playback/playbackSwitch.js';
import { matchQuery } from '../public/js/youtube/videoMatcher.js';
import { YouTubePlayback } from '../public/js/youtube/youtubePlayback.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import {
  MatchCache,
  parseIsoDuration,
  parseMatchQuery,
  rankByDuration,
  searchQuery,
} from '../server/youtubeMatches.js';

const API_KEY = 'test-youtube-key';
const TEST_PORT = 18941;
const ORIGIN = `http://127.0.0.1:${TEST_PORT}`;

// --- Server: matching songs to videos ---

test('search text leaves out remaster notes but keeps the rest of the title', () => {
  assert.equal(searchQuery('Here Comes the Sun - Remastered 2009', 'The Beatles'), 'The Beatles Here Comes the Sun');
  assert.equal(searchQuery('Dreams (2004 Remaster)', 'Fleetwood Mac'), 'Fleetwood Mac Dreams');
  assert.equal(searchQuery('Song (feat. Someone)', 'Artist'), 'Artist Song (feat. Someone)');
  assert.equal(searchQuery('Untitled', ''), 'Untitled');
});

test('reads ISO 8601 durations, and rejects anything else', () => {
  assert.equal(parseIsoDuration('PT4M13S'), 253_000);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3_723_000);
  assert.equal(parseIsoDuration('PT45S'), 45_000);
  assert.equal(parseIsoDuration('P0D'), 0);
  assert.equal(parseIsoDuration('4:13'), null);
  assert.equal(parseIsoDuration(undefined), null);
});

test('videos close to the song\'s length come first, keeping YouTube\'s order within each band', () => {
  const song = 200_000;
  const videos = [
    { id: 'music-video', durationMs: 290_000 }, // a long cut with an intro
    { id: 'live', durationMs: 230_000 },
    { id: 'unknown', durationMs: null },
    { id: 'studio', durationMs: 201_000 },
    { id: 'lyric', durationMs: 195_000 },
  ];
  assert.deepEqual(
    rankByDuration(videos, song).map((video) => video.id),
    ['studio', 'lyric', 'live', 'music-video', 'unknown'],
  );
  assert.deepEqual(rankByDuration(videos, null), videos, 'without a length to compare, order is kept');
});

test('match requests need a title, and reasonable lengths and durations', () => {
  const parse = (query) => parseMatchQuery(new URLSearchParams(query));
  assert.deepEqual(parse('title=Song&artist=Band&durationMs=200000'), { title: 'Song', artist: 'Band', durationMs: 200_000 });
  assert.deepEqual(parse('title=Song'), { title: 'Song', artist: '', durationMs: null });
  assert.equal(parse('artist=Band'), null);
  assert.equal(parse('title=%20%20'), null);
  assert.equal(parse(`title=${'x'.repeat(301)}`), null);
  assert.equal(parse('title=Song&durationMs=-5'), null);
  assert.equal(parse('title=Song&durationMs=1.5'), null);
  assert.equal(parse('title=Song&durationMs=abc'), null);
});

test('the browser asks for a song by title, all its artists and its length', () => {
  const params = matchQuery({ title: 'Song', artists: ['A', 'B'], durationMs: 200_000.4 });
  assert.equal(params.toString(), 'title=Song&artist=A%2C+B&durationMs=200000');
  assert.equal(matchQuery({ title: 'Song', artists: [], durationMs: 0 }).has('durationMs'), false);
});

/** Fake YouTube Data API. `respond` decides each answer; `calls` records every request. */
const youtube = {
  calls: [],
  respond: null,
};
const youtubeFetch = async (url) => {
  const parsed = new URL(url);
  youtube.calls.push(parsed);
  return youtube.respond(parsed);
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function searchAnswer(items) {
  return (url) => {
    if (url.pathname.endsWith('/search')) {
      return json({ items: items.map(({ id, title }) => ({ id: { videoId: id }, snippet: { title, channelTitle: 'Channel' } })) });
    }
    return json({
      items: items.map(({ id, duration, embeddable = true }) => ({
        id,
        contentDetails: { duration },
        status: { embeddable },
      })),
    });
  };
}

let server;
before(async () => {
  const config = loadConfig({ YOUTUBE_API_KEY: API_KEY });
  server = createApp(config, youtubeFetch, { matchCache: new MatchCache({ filePath: null }) });
  await new Promise((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));
});
after(() => server.close());

const match = (query) => fetch(`${ORIGIN}/youtube/match?${new URLSearchParams(query)}`);

test('a match searches once, checks lengths, and answers best first without revealing the key', async () => {
  youtube.calls = [];
  youtube.respond = searchAnswer([
    { id: 'live', title: 'Song (Live)', duration: 'PT4M40S' },
    { id: 'blocked', title: 'Song', duration: 'PT3M20S', embeddable: false },
    { id: 'studio', title: 'Song (Audio)', duration: 'PT3M21S' },
  ]);

  const response = await match({ title: 'Song', artist: 'Band', durationMs: '200000' });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(API_KEY));
  assert.deepEqual(
    JSON.parse(text).videos.map((video) => video.id),
    ['studio', 'live'],
    'the unembeddable video is dropped and the closest length leads',
  );

  const [search, videos] = youtube.calls;
  assert.equal(search.searchParams.get('q'), 'Band Song');
  assert.equal(search.searchParams.get('videoEmbeddable'), 'true');
  assert.equal(search.searchParams.get('key'), API_KEY);
  assert.equal(videos.searchParams.get('id'), 'live,blocked,studio');
  assert.equal(youtube.calls.length, 2);
});

test('a song already matched is answered from memory, without spending quota', async () => {
  youtube.calls = [];
  youtube.respond = searchAnswer([{ id: 'only', title: 'Other', duration: 'PT3M' }]);
  const first = await (await match({ title: 'Remembered', artist: 'Band' })).json();
  const second = await (await match({ title: 'remembered', artist: 'BAND' })).json();
  assert.deepEqual(second, first);
  assert.equal(youtube.calls.length, 2, 'one search and one length check, for both requests');
});

test('concurrent requests for one song share a single search', async () => {
  youtube.calls = [];
  youtube.respond = searchAnswer([{ id: 'v', title: 'V', duration: 'PT3M' }]);
  await Promise.all([match({ title: 'Popular' }), match({ title: 'Popular' }), match({ title: 'Popular' })]);
  assert.equal(youtube.calls.filter((url) => url.pathname.endsWith('/search')).length, 1);
});

test('a spent daily quota is reported plainly, and nothing is remembered', async () => {
  youtube.respond = () => json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403);
  const response = await match({ title: 'Over Quota' });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /daily search limit/);

  youtube.calls = [];
  youtube.respond = searchAnswer([{ id: 'later', title: 'Later', duration: 'PT3M' }]);
  const retry = await (await match({ title: 'Over Quota' })).json();
  assert.deepEqual(retry.videos.map((video) => video.id), ['later']);
});

test('a bad match request gets a 400 without calling YouTube', async () => {
  youtube.calls = [];
  const response = await match({ artist: 'No title' });
  assert.equal(response.status, 400);
  assert.equal(youtube.calls.length, 0);
});

test('without a YouTube key, matching is refused and the status says so', async () => {
  const unconfigured = createApp(loadConfig({}), youtubeFetch, { matchCache: new MatchCache({ filePath: null }) });
  await new Promise((resolve) => unconfigured.listen(TEST_PORT + 1, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${TEST_PORT + 1}`;
    const response = await fetch(`${base}/youtube/match?title=Song`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /YOUTUBE_API_KEY/);
    assert.equal((await (await fetch(`${base}/auth/status`)).json()).youtubeConfigured, false);
  } finally {
    unconfigured.close();
  }
  assert.equal((await (await fetch(`${ORIGIN}/auth/status`)).json()).youtubeConfigured, true);
});

test('pages send YouTube the origin it needs, and never a full URL', async () => {
  const response = await fetch(`${ORIGIN}/`);
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
});

test('matches are saved to disk, survive a restart, and expire after 30 days', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-cache-'));
  try {
    const filePath = join(directory, 'nested', 'matches.json');
    const videos = [{ id: 'v1', title: 'T', channel: 'C', durationMs: 1000 }];
    await new MatchCache({ filePath }).set('band\nsong', videos);
    await new Promise((resolve) => setTimeout(resolve, 1200)); // saving waits a moment to batch changes
    assert.ok((await readFile(filePath, 'utf8')).includes('v1'));

    let now = Date.now();
    const restarted = new MatchCache({ filePath, now: () => now });
    assert.deepEqual(await restarted.get('band\nsong'), videos);
    now += 31 * 24 * 60 * 60 * 1000;
    assert.equal(await restarted.get('band\nsong'), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// --- Browser: the YouTube player ---

const PLAYING = 1;
const PAUSED = 2;
const ENDED = 0;

const song = (n, extra = {}) => ({
  uri: `spotify:track:${n}`,
  title: `Song ${n}`,
  artists: ['Band'],
  durationMs: 200_000,
  artThumbUrl: `art-${n}`,
  isLocal: false,
  ...extra,
});

/** A YouTubePlayback with a fake player, TV and server, recording what it's asked to do. */
function youtubeHarness(videosBySong = {}) {
  const calls = [];
  let handlers;
  const player = {
    time: 0,
    duration: 0,
    loadVideoById: (id) => calls.push(['load', id]),
    playVideo: () => calls.push(['play']),
    pauseVideo: () => calls.push(['pause']),
    stopVideo: () => calls.push(['stop']),
    seekTo: (seconds) => calls.push(['seek', seconds]),
    setVolume: (volume) => calls.push(['volume', volume]),
    getCurrentTime: () => player.time,
    getDuration: () => player.duration,
  };
  const tv = { mountElement: {}, shown: null, show: (status) => (tv.shown = status), hide: () => (tv.shown = null) };
  const searches = [];
  const findVideos = async (track) => {
    searches.push(track.uri);
    return videosBySong[track.uri] ?? [{ id: `video-${track.uri}`, title: track.title, channel: 'Band' }];
  };
  const playback = new YouTubePlayback({
    tv,
    findVideos,
    createPlayer: async (_element, given) => {
      handlers = given;
      return player;
    },
  });
  const states = [];
  const errors = [];
  playback.onState((state) => states.push(state));
  playback.onError((message) => errors.push(message));
  return {
    playback,
    player,
    tv,
    calls,
    searches,
    states,
    errors,
    loads: () => calls.filter(([name]) => name === 'load').map(([, id]) => id),
    fire: (state) => handlers.onStateChange(state),
    fail: (code) => handlers.onError(code),
  };
}

test('playing a song finds it, loads the best video, and reports the Spotify song\'s details', async () => {
  const h = youtubeHarness();
  const playlist = { uri: 'spotify:playlist:p', tracks: [song(1), song(2)] };
  await h.playback.playTrack(playlist.tracks[0], playlist, playlist.tracks);

  assert.deepEqual(h.loads(), ['video-spotify:track:1']);
  assert.match(h.tv.shown, /^YouTube: Song 1/);
  h.player.time = 12;
  h.player.duration = 203;
  h.fire(PLAYING);

  assert.deepEqual(h.states.at(-1), {
    uris: ['spotify:track:1'],
    title: 'Song 1',
    artist: 'Band',
    artUrl: 'art-1',
    paused: false,
    contextUri: 'spotify:playlist:p',
    positionMs: 12_000,
    durationMs: 203_000,
  });
  h.fire(PAUSED);
  assert.equal(h.states.at(-1).paused, true);
});

test('a video that won\'t play here gives way to the next match, then the song is reported', async () => {
  const h = youtubeHarness({
    'spotify:track:1': [
      { id: 'blocked', title: 'A', channel: '' },
      { id: 'removed', title: 'B', channel: '' },
    ],
  });
  await h.playback.playTrack(song(1), null, [song(1)]);
  h.fail(150);
  assert.deepEqual(h.loads(), ['blocked', 'removed']);
  h.fail(100);
  assert.deepEqual(h.loads(), ['blocked', 'removed'], 'nothing left to try');
  assert.match(h.errors.at(-1), /No YouTube video of “Song 1”/);
  assert.match(h.tv.shown, /No YouTube video/);
});

test('at the end of a song the next one plays, skipping unplayable songs, and the list stops at its end', async () => {
  const tracks = [song(1), song(2), song(3)];
  const h = youtubeHarness({ 'spotify:track:2': [] });
  await h.playback.playTrack(tracks[0], null, tracks);
  h.fire(PLAYING);
  h.fire(ENDED);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(h.searches, ['spotify:track:1', 'spotify:track:2', 'spotify:track:3']);
  assert.deepEqual(h.loads(), ['video-spotify:track:1', 'video-spotify:track:3']);
  assert.match(h.errors.at(-1), /Skipping to the next song/);

  h.fire(PLAYING);
  h.fire(ENDED);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.loads().length, 2, 'nothing plays after the last song');
  assert.equal(h.states.at(-1).paused, true);
});

test('a chosen song with no match isn\'t skipped', async () => {
  const tracks = [song(1), song(2)];
  const h = youtubeHarness({ 'spotify:track:1': [] });
  await h.playback.playTrack(tracks[0], null, tracks);
  assert.deepEqual(h.loads(), []);
  assert.deepEqual(h.searches, ['spotify:track:1']);
  assert.equal(h.states.at(-1).title, 'Song 1');
});

test('a slow search for an earlier song doesn\'t replace the one chosen after it', async () => {
  let releaseFirst;
  const h = youtubeHarness();
  const playback = new YouTubePlayback({
    tv: h.tv,
    findVideos: (track) =>
      track.uri === 'spotify:track:1'
        ? new Promise((resolve) => (releaseFirst = () => resolve([{ id: 'slow', title: '', channel: '' }])))
        : Promise.resolve([{ id: 'fast', title: '', channel: '' }]),
    createPlayer: async () => h.player,
  });
  const first = playback.playTrack(song(1), null, [song(1), song(2)]);
  await playback.playTrack(song(2), null, [song(1), song(2)]);
  releaseFirst();
  await first;
  assert.deepEqual(h.loads(), ['fast']);
});

test('playlists play on past the shelf; local files are left out', async () => {
  const local = song(2, { isLocal: true });
  const playlist = { uri: 'spotify:playlist:p', tracks: [song(1), local, song(3)] };
  const h = youtubeHarness();
  await h.playback.playTrack(playlist.tracks[0], playlist, [playlist.tracks[0]]);
  await h.playback.next();
  assert.deepEqual(h.searches, ['spotify:track:1', 'spotify:track:3']);
});

test('seeking reports the new position at once; volume is kept for the player', async () => {
  const h = youtubeHarness();
  h.playback.setVolume(0.25);
  await h.playback.playTrack(song(1), null, [song(1)]);
  assert.deepEqual(h.calls.find(([name]) => name === 'volume'), ['volume', 25]);

  await h.playback.seek(30_000);
  assert.equal(h.calls.some(([name]) => name === 'seek'), false, 'nothing to seek before the video starts');
  h.fire(PLAYING);
  await h.playback.seek(30_000);
  assert.deepEqual(h.calls.at(-1), ['seek', 30]);
  assert.equal(h.states.at(-1).positionMs, 30_000);
});

test('stopping puts the TV away and reports that nothing is playing', async () => {
  const h = youtubeHarness();
  await h.playback.playTrack(song(1), null, [song(1)]);
  h.playback.stop();
  assert.equal(h.tv.shown, null);
  assert.equal(h.states.at(-1), null);
});

// --- Browser: switching between Spotify and YouTube ---

function fakeSource(name) {
  const source = {
    name,
    calls: [],
    stateListeners: [],
    errorListeners: [],
    onState: (callback) => source.stateListeners.push(callback),
    onError: (callback) => source.errorListeners.push(callback),
    emitState: (state) => source.stateListeners.forEach((listener) => listener(state)),
    emitError: (message, details) => source.errorListeners.forEach((listener) => listener(message, details)),
    start: () => source.calls.push('start'),
    playTrack: async () => source.calls.push('playTrack'),
    toggle: async () => source.calls.push('toggle'),
    next: async () => source.calls.push('next'),
    previous: async () => source.calls.push('previous'),
    seek: async () => source.calls.push('seek'),
    setVolume: () => source.calls.push('setVolume'),
    pause: async () => source.calls.push('pause'),
    stop: () => source.calls.push('stop'),
  };
  return source;
}

function switchHarness(source = SPOTIFY) {
  const spotify = fakeSource('spotify');
  const youtube = fakeSource('youtube');
  const playback = new PlaybackSwitch({ spotify, youtube, source });
  const states = [];
  const errors = [];
  playback.onState((state) => states.push(state));
  playback.onError((message, details) => errors.push({ message, ...details }));
  return { spotify, youtube, playback, states, errors };
}

test('only the chosen source plays and is heard from', async () => {
  const h = switchHarness(YOUTUBE);
  await h.playback.playTrack();
  await h.playback.toggle();
  h.spotify.emitState({ from: 'spotify' });
  h.youtube.emitState({ from: 'youtube' });
  h.spotify.emitError('spotify hiccup', { fatal: false });

  assert.deepEqual(h.youtube.calls, ['playTrack', 'toggle']);
  assert.deepEqual(h.spotify.calls, []);
  assert.deepEqual(h.states, [{ from: 'youtube' }]);
  assert.deepEqual(h.errors, []);
});

test('switching stops the old source and clears the player bar; volume reaches both', async () => {
  const h = switchHarness(SPOTIFY);
  await h.playback.setSource(YOUTUBE);
  assert.deepEqual(h.spotify.calls, ['pause']);
  assert.deepEqual(h.states, [null]);

  await h.playback.setSource(SPOTIFY);
  assert.deepEqual(h.youtube.calls, ['stop']);

  h.playback.setVolume(0.5);
  assert.ok(h.spotify.calls.includes('setVolume') && h.youtube.calls.includes('setVolume'));
});

test('when Spotify can\'t play here, YouTube takes over for good', async () => {
  const h = switchHarness(SPOTIFY);
  const sources = [];
  h.playback.onSource((source) => sources.push(source));
  h.spotify.emitError('Playing songs here requires Spotify Premium.', { fatal: true });

  assert.equal(h.playback.source, YOUTUBE);
  assert.equal(h.playback.canSwitch, false);
  assert.deepEqual(sources, [YOUTUBE]);
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].fatal, false, 'playback still works, so the song panel keeps its play button');
  assert.match(h.errors[0].message, /YouTube on the TV instead/);

  await h.playback.setSource(SPOTIFY);
  assert.equal(h.playback.source, YOUTUBE, 'switching back isn\'t possible');
});

test('a song that fails because Spotify just turned out unusable plays from YouTube', async () => {
  const h = switchHarness(SPOTIFY);
  h.spotify.playTrack = async () => {
    h.spotify.emitError('No Premium.', { fatal: true });
    throw new Error('No Premium.');
  };
  await h.playback.playTrack();
  assert.deepEqual(h.youtube.calls, ['playTrack']);
});

test('other Spotify failures still reach the caller', async () => {
  const h = switchHarness(SPOTIFY);
  h.spotify.playTrack = async () => {
    throw new Error('Spotify could not play that song.');
  };
  await assert.rejects(h.playback.playTrack(), /could not play/);
  assert.deepEqual(h.youtube.calls, []);
});
